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

import { loadMetadataFieldIndex, requireDifyWriteConfig, fetchJsonWithTimeout } from "./dify.js";

// Per-document debounce cache: documentId -> { lastStampMs, recallCount }.
// Module-scoped, so it resets on a hot-reload / restart (cold cache re-stamps
// once, which is harmless — the stamp is idempotent-enough).
const stampCache = new Map();

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

    const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(selectedDatasetId)}/documents/metadata`;
    const iso = new Date(now).toISOString();

    for (const id of targets) {
      const prev = stampCache.get(id);
      const nextCount = (prev?.recallCount || 0) + 1;
      const metadataList = [{ id: recalledField.id, name: "last_recalled_at", value: iso }];
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
        stampCache.set(id, { lastStampMs: now, recallCount: nextCount });
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
