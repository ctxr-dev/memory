// Fire-and-forget recall instrumentation for the staleness signal.
//
// recall_lessons / search_memory call stampRecallsFireAndForget AFTER they have
// assembled their response, so stamping never delays or fails a read. For each
// returned document we stamp last_recalled_at (ISO) + bump recall_count, so the
// consolidate staleness pass can tell "old AND unused" from "old but actively
// recalled".
//
// Write-amplification controls:
//   1. ONE metadata-field-index GET per dataset per call (not per doc).
//   2. Multiple chunks of the same document collapse to one stamp.
//   3. An in-process per-document debounce Map (lastStampMs + recallCount).
//   4. A debounce window (MEMORY_RECALL_STAMP_DEBOUNCE_HOURS, default 24h).
//
// Lives under mcp-server/src so the container sees it; reads its own env (the
// host env.mjs is not importable in-container). Imports dify.js primitives.

import { loadMetadataFieldIndex, requireDifyWriteConfig, fetchJsonWithTimeout, listAllDocuments } from "./dify.js";

// Dify built-in metadata keys appear in a document's doc_metadata but are
// auto-managed; never echo them back on a write.
const DIFY_BUILTIN_META = new Set(["document_name", "uploader", "upload_date", "last_update_date", "source"]);

// Per-document debounce cache: documentId -> { lastStampMs, recallCount }.
// Module-scoped, so it resets on a hot-reload / restart (cold cache re-stamps
// once, which is harmless; the stamp is idempotent-enough). Bounded so the
// long-lived bridge process cannot grow it without limit: Map preserves
// insertion order, so we evict the oldest entries past the cap.
const STAMP_CACHE_MAX = 5000;
const stampCache = new Map();

// NOTE: we deliberately do NOT cache the per-dataset metadata map across calls.
// A cached snapshot can go stale within its TTL, and because the metadata POST
// REPLACES the full custom-metadata set, writing from a stale snapshot would
// roll back any field another writer (consolidate, a concurrent recall) changed
// in the meantime. Correctness beats avoiding the re-list; the list is
// fire-and-forget and debounced, so it only runs when a doc actually needs a stamp.

function cacheSet(map, key, value, max) {
  map.set(key, value);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function debounceHoursFromEnv() {
  const n = Number.parseInt(process.env.MEMORY_RECALL_STAMP_DEBOUNCE_HOURS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

// Pure debounce predicate. Absent/unparseable lastIso => stamp; otherwise stamp
// only once the debounce window has elapsed.
export function shouldStamp(lastIso, nowMs, debounceHours) {
  const last = lastIso ? Date.parse(lastIso) : NaN;
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= debounceHours * 60 * 60 * 1000;
}

// Stamp last_recalled_at + recall_count on each unique returned document in ONE
// dataset. Loads the field index once; no-ops if the dataset lacks
// last_recalled_at. Per-doc failures are swallowed (logged to stderr only).
// Returns a small summary (handy for tests). NEVER throws.
export async function stampRecalls(config, { datasetId, records, nowMs, debounceHours } = {}) {
  const summary = { dataset: datasetId, stamped: 0, skipped: 0, fieldGets: 0, errors: 0 };
  try {
    const debounce = Number.isFinite(debounceHours) ? debounceHours : debounceHoursFromEnv();
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();

    // Unique documentIds (collapse multi-chunk hits), debounced.
    const seen = new Set();
    const targets = [];
    for (const rec of records || []) {
      const id = rec?.documentId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const cached = stampCache.get(id);
      const lastIso = cached?.lastStampMs ? new Date(cached.lastStampMs).toISOString() : null;
      if (!shouldStamp(lastIso, now, debounce)) {
        summary.skipped++;
        continue;
      }
      targets.push(id);
    }
    if (targets.length === 0) return summary;

    let selectedDatasetId;
    try {
      selectedDatasetId = requireDifyWriteConfig(config, datasetId);
    } catch {
      return summary; // no write config — silent no-op
    }

    const fieldIndex = await loadMetadataFieldIndex(config, { datasetId: selectedDatasetId });
    summary.fieldGets = 1;
    const recalledField = fieldIndex.get("last_recalled_at");
    if (!recalledField) return summary; // dataset not migrated; nothing to do
    const countField = fieldIndex.get("recall_count");

    // Dify's documents/metadata POST REPLACES a document's full custom-metadata
    // set, so we MUST carry every existing custom field on the write or it is
    // wiped (atom_type / project_module / error_pattern lost). Read the dataset's
    // CURRENT metadata map fresh (no cross-call cache: a stale snapshot would
    // roll back fields another writer changed). If the read fails we DO NOT stamp
    // (better to skip the staleness signal than to corrupt classifying metadata).
    let metaById;
    try {
      const docs = await listAllDocuments(config, { datasetId: selectedDatasetId });
      metaById = new Map();
      for (const d of docs || []) {
        const m = {};
        const fields = Array.isArray(d?.doc_metadata) ? d.doc_metadata : [];
        for (const f of fields) if (f?.name) m[f.name] = f.value;
        metaById.set(d.id, m);
      }
    } catch (err) {
      process.stderr.write(`[recall-stamp] skip stamping ${selectedDatasetId}: could not read current metadata (would risk a wipe): ${err?.message || err}\n`);
      return summary;
    }

    const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(selectedDatasetId)}/documents/metadata`;
    const iso = new Date(now).toISOString();

    for (const id of targets) {
      const prev = stampCache.get(id);
      // The doc MUST be present in the snapshot to stamp safely: metaById.get()
      // returns {} for a found doc with no custom fields, but also `undefined`
      // for a doc absent from the listing (eventual-consistency / indexing lag).
      // Stamping an absent doc would POST only the recall fields, and since Dify
      // REPLACES the full custom set, that wipes atom_type / project_module / etc.
      // Skip rather than risk a wipe; a later recall re-stamps once it is indexed.
      if (!metaById.has(id)) {
        summary.skipped++;
        continue;
      }
      const existing = metaById.get(id);
      // Persisted debounce: also honor the doc's stored last_recalled_at, so a
      // cold in-process cache (after a restart / hot-reload) does not re-stamp a
      // document that Dify already records as recently recalled.
      if (!shouldStamp(existing.last_recalled_at, now, debounce)) {
        summary.skipped++;
        cacheSet(stampCache, id, { lastStampMs: Date.parse(existing.last_recalled_at) || now, recallCount: Number(existing.recall_count) || 0 }, STAMP_CACHE_MAX);
        continue;
      }
      // Seed the counter from the in-process cache if present, otherwise from the
      // PERSISTED recall_count (so a process restart / cold cache does not reset
      // the count back to 1 and lose history).
      const cachedCount = prev?.recallCount;
      const persistedCount = Number(existing.recall_count);
      const baseCount = Number.isFinite(cachedCount) ? cachedCount : Number.isFinite(persistedCount) ? persistedCount : 0;
      const nextCount = baseCount + 1;
      // Preserve every existing custom field (those defined on the dataset),
      // overriding only the two recall fields. Skip Dify built-ins.
      const metadataList = [];
      for (const [name, f] of fieldIndex) {
        if (name === "last_recalled_at" || name === "recall_count") continue;
        if (DIFY_BUILTIN_META.has(name)) continue;
        const v = existing[name];
        if (v != null && v !== "") metadataList.push({ id: f.id, name, value: String(v) });
      }
      metadataList.push({ id: recalledField.id, name: "last_recalled_at", value: iso });
      if (countField) metadataList.push({ id: countField.id, name: "recall_count", value: String(nextCount) });
      try {
        await fetchJsonWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ operation_data: [{ document_id: id, metadata_list: metadataList }] }),
          },
          config.timeoutMs,
        );
        cacheSet(stampCache, id, { lastStampMs: now, recallCount: nextCount }, STAMP_CACHE_MAX);
        summary.stamped++;
      } catch (err) {
        summary.errors++;
        process.stderr.write(`[recall-stamp] stamp failed for ${id} in ${selectedDatasetId}: ${err?.message || err}\n`);
      }
    }
    return summary;
  } catch (err) {
    process.stderr.write(`[recall-stamp] stampRecalls failed for ${datasetId}: ${err?.message || err}\n`);
    return summary;
  }
}

// Group an assembled record list (each carrying datasetId + documentId) by
// dataset and stamp each. NEVER awaited by the caller and NEVER rejects: this is
// the fire-and-forget entry point the tool handlers call right before returning.
export function stampRecallsFireAndForget(config, records, nowMs) {
  return Promise.resolve()
    .then(async () => {
      const byDataset = new Map();
      for (const rec of records || []) {
        const ds = rec?.datasetId;
        const id = rec?.documentId;
        if (!ds || !id) continue;
        let arr = byDataset.get(ds);
        if (!arr) {
          arr = [];
          byDataset.set(ds, arr);
        }
        arr.push(rec);
      }
      for (const [datasetId, recs] of byDataset) {
        await stampRecalls(config, { datasetId, records: recs, nowMs });
      }
    })
    .catch((err) => {
      process.stderr.write(`[recall-stamp] fire-and-forget dispatch error: ${err?.message || err}\n`);
    });
}

// Test-only: reset the in-process debounce cache between cases.
export function _resetStampCache() {
  stampCache.clear();
}
