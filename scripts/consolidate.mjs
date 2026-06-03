// Consolidate orchestrator (host engine).
//
// A faithful RAG adaptation of llm-wiki-memory's consolidate: deterministic
// dedup (sha256 / lesson-key / similarity) then optional LLM merge, age-based
// staleness flag then optional LLM refresh, and compress-archived. It runs
// host-side like compile.mjs (uses the host LLM client + the Dify bridge), is
// the ONLY mutator, and is what the cron calls. The read-only MCP projector
// reuses the same pure core (mcp-server/src/consolidate-core.js) for dry-run.
//
// Eligibility is policy-driven (MEMORY_CONSOLIDATE_<SLOT>=refine|none); an
// undeclared bound slot makes the run refuse (the layout-missing-consolidate
// analog). Every Dify/LLM/IO touch goes through an injected `deps` object so the
// engine unit-tests with fakes and never hits a real bridge.
//
// FS-only upstream passes (orphan-prune, prune-empty-ancestors, index-rebuild,
// prune-embeddings) are intentionally absent: Dify has no link graph, directory
// tree, index.md, or client embedding cache.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROMPTS_DIR,
  CONSOLIDATE_STATE_PATH,
  COMPILE_LOCK_PATH,
  consolidateIntervalDays,
  consolidateSimilarityThreshold,
  consolidateClusterTopK,
  consolidateClusterScoreThreshold,
  consolidateStaleAfterMonths,
  consolidateRefreshMaxPerRun,
  consolidateArchiveAgeDays,
  consolidateArchiveBodyMax,
  consolidateAtomBodyMaxChars,
  consolidateLlmEnabled,
  consolidatePassesEnv,
  readEnvFile,
} from "./lib/env.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lib/lock.mjs";
import { callLLMWithRetry, LLMProviderUnavailable } from "./lib/llm.mjs";
import {
  listForConsolidate,
  readDocument,
  searchMemoryFiltered,
  saveDocument,
  disableDocument,
  updateDocMetadata,
} from "./lib/dify-write.mjs";
import { resolveAllPolicies } from "../mcp-server/src/consolidate-policy.js";
import {
  SOURCE_PASSES,
  sha256Pairs,
  lessonKeyPairs,
  similarityPairs,
  dedupePairs,
  partitionByArchivePolicy,
  isStale,
  staleCandidates,
  compressCandidates,
} from "../mcp-server/src/consolidate-core.js";

// Dify's hit-testing/retrieval endpoint rejects a query longer than 250 chars
// ("String should have at most 250 characters"), and the error comes back in
// the per-dataset errors array (NOT as a thrown error), so an over-long query
// silently yields an empty cluster. Cap the body-derived cluster query well
// under that limit. The leading chars (title + lead) are the strongest
// near-duplicate signal anyway.
const DIFY_QUERY_MAX_CHARS = 240;

// Dify's documents/metadata POST REPLACES a document's full custom-metadata set
// (it is not a per-field merge). So every consolidate stamp MUST carry ALL of the
// document's existing custom fields too, or they are wiped. We preserve every
// existing field EXCEPT Dify's auto-managed built-ins (which must not be echoed
// back) -- this also keeps any user-added custom fields beyond our own set.
const DIFY_BUILTIN_META = new Set(["document_name", "uploader", "upload_date", "last_update_date", "source"]);

// Merge a stamp `patch` onto a leaf's EXISTING custom metadata (preserving every
// non-built-in field Dify would otherwise drop on a partial write).
function stampMeta(leaf, patch) {
  const out = {};
  const m = leaf?.metadata || {};
  for (const [k, v] of Object.entries(m)) {
    if (DIFY_BUILTIN_META.has(k)) continue;
    if (v != null && v !== "") out[k] = v;
  }
  return { ...out, ...patch };
}

export const ALL_PASS_NAMES = Object.freeze([
  SOURCE_PASSES.SHA256,
  SOURCE_PASSES.LESSON_KEY,
  SOURCE_PASSES.SIMILARITY,
  "llm-merge-near-duplicates",
  "staleness-flag",
  "llm-semantic-refresh",
  "compress-archived",
]);

// ─── helpers ────────────────────────────────────────────────────────────────

function toIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}
function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "string" && now) {
    const t = Date.parse(now);
    return Number.isFinite(t) ? t : Date.now();
  }
  return Date.now();
}

function emptyReport(name) {
  return { name, archived: 0, merged: 0, refreshed: 0, flagged: 0, touched: 0, errors: 0, freedBytes: 0, ms: 0 };
}

const ALL_PASS_SET = new Set(ALL_PASS_NAMES);

// Drop any pass name not in ALL_PASS_NAMES and warn (a typo in --passes= or
// MEMORY_CONSOLIDATE_PASSES would otherwise silently select nothing / the wrong
// set). Returns the filtered set of known names.
function filterKnownPasses(names) {
  const unknown = [...names].filter((n) => !ALL_PASS_SET.has(n));
  if (unknown.length) {
    process.stderr.write(`[consolidate] ignoring unknown pass name(s): ${unknown.join(", ")} (valid: ${ALL_PASS_NAMES.join(", ")})\n`);
  }
  return new Set([...names].filter((n) => ALL_PASS_SET.has(n)));
}

export function resolveAllowedPasses(passesArg) {
  const fromCsv = (raw) => {
    const parts = String(raw).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (parts.length === 0 || parts.includes("all")) return new Set(ALL_PASS_NAMES);
    return filterKnownPasses(new Set(parts));
  };
  if (passesArg == null) {
    const raw = consolidatePassesEnv();
    if (!raw || raw === "all") return new Set(ALL_PASS_NAMES);
    return fromCsv(raw);
  }
  if (Array.isArray(passesArg)) {
    const parts = passesArg.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (parts.includes("all")) return new Set(ALL_PASS_NAMES);
    return filterKnownPasses(new Set(parts));
  }
  const str = String(passesArg).trim();
  if (str === "") return new Set();
  return fromCsv(str);
}

// Normalise a list-consolidate document row into a core leaf. Dify created_at
// is epoch SECONDS; the core wants epoch ms.
function toLeaf(row, category) {
  return {
    documentId: row.documentId || row.id,
    name: row.name,
    category,
    createdAtMs: (Number(row.createdAt ?? row.created_at) || 0) * 1000,
    enabled: row.enabled !== false,
    metadata: row.metadata || {},
    body: undefined,
  };
}

function loadPrompt(file) {
  const cap = consolidateAtomBodyMaxChars();
  return fs.readFileSync(path.join(PROMPTS_DIR, file), "utf8").replace(/\{\{ATOM_BODY_MAX_CHARS\}\}/g, String(cap));
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONSOLIDATE_STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(CONSOLIDATE_STATE_PATH), { recursive: true });
    fs.writeFileSync(CONSOLIDATE_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`[consolidate] state write failed: ${err?.message || err}\n`);
  }
}

// Default deps wire the real host implementations. Tests pass their own.
export function defaultDeps() {
  return {
    loadEnv: () => ({ ...readEnvFile(), ...process.env }),
    listForConsolidate: (a) => listForConsolidate(a),
    readBody: async ({ documentId, datasetId }) => {
      const r = await readDocument({ documentId, datasetId });
      return r?.text || "";
    },
    searchSimilar: (a) => searchMemoryFiltered(a),
    saveDoc: async ({ name, text, datasetId, metadata }) => {
      const r = await saveDocument({ name, text, datasetId, metadata });
      const id = r?.created?.document?.id || r?.created?.id || r?.document?.id || r?.documentId || null;
      return { id, raw: r };
    },
    disableDoc: (a) => disableDocument(a),
    updateMeta: (a) => updateDocMetadata(a),
    llm: (a) => callLLMWithRetry(a),
    // Shared with compile so the two never race / share one LLM window. Injected
    // so tests pass a no-op lock (avoids cross-test-file contention on the real
    // lock file, which node --test's parallel file processes would otherwise hit).
    acquireLock: () => {
      installLockReleaseHandlers(COMPILE_LOCK_PATH);
      return acquireLock(COMPILE_LOCK_PATH, { label: "consolidate" });
    },
    readState,
    writeState,
  };
}

// Extract the new keeper id from a saveDoc result, throwing if absent (we must
// not stamp a loser's superseded_by with a null id).
function requireNewId(saveResult, context) {
  const id = saveResult?.id;
  if (!id) throw new Error(`saveDoc did not return a document id (${context})`);
  return id;
}

// ─── per-slot dedup ───────────────────────────────────────────────────────────

// Dedup is computed per RETRIEVAL CLUSTER (top-K similar docs per query leaf),
// not globally over the whole slot: a global all-pairs sha256/lesson-key scan
// would need every body in memory at once. Two duplicates are paired when one
// falls in the other's top-K cluster, which for exact / near-exact bodies is
// effectively certain (their similarity score is ~1.0, well above the cluster
// floor). The read-only MCP projector instead computes lesson-key candidates
// globally over the active set, so its lesson-key count can differ slightly
// from a host run's; that is expected (the projector is a cheap estimate).
async function buildPairsForSlot({ slot, leaves, allowed, deps, simThreshold, topK, clusterScore, report }) {
  const byId = new Map(leaves.map((l) => [l.documentId, l]));
  const bodyCache = new Map();
  const getBody = async (leaf) => {
    if (bodyCache.has(leaf.documentId)) return bodyCache.get(leaf.documentId);
    const body = await deps.readBody({ documentId: leaf.documentId, datasetId: slot });
    bodyCache.set(leaf.documentId, body);
    leaf.body = body;
    return body;
  };

  const wantSha = allowed.has(SOURCE_PASSES.SHA256);
  const wantLesson = allowed.has(SOURCE_PASSES.LESSON_KEY);
  const wantSim = allowed.has(SOURCE_PASSES.SIMILARITY);
  if (!wantSha && !wantLesson && !wantSim) return [];

  // The cluster lookup feeds whichever dedup passes are enabled, so attribute a
  // lookup failure to an ENABLED pass (not always similarity, which may be off).
  const clusterErrorPass = wantSim ? SOURCE_PASSES.SIMILARITY : wantSha ? SOURCE_PASSES.SHA256 : SOURCE_PASSES.LESSON_KEY;

  const sorted = [...leaves].sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
  const allPairs = [];

  for (const leaf of sorted) {
    let cluster;
    try {
      const body = await getBody(leaf);
      cluster = await deps.searchSimilar({
        query: String(body).slice(0, DIFY_QUERY_MAX_CHARS),
        datasetId: slot,
        limit: topK,
        scoreThreshold: clusterScore,
      });
    } catch (err) {
      report.get(clusterErrorPass).errors++;
      process.stderr.write(`[consolidate] cluster lookup failed for ${leaf.documentId}: ${err?.message || err}\n`);
      continue;
    }
    const records = Array.isArray(cluster?.records) ? cluster.records : [];
    const clusterLeaves = [];
    for (const rec of records) {
      const id = rec.documentId;
      if (!id || id === leaf.documentId) continue;
      const base = byId.get(id);
      if (!base) continue; // not an active working-set doc
      base.score = rec.score;
      if (base.body === undefined) {
        try {
          await getBody(base);
        } catch {
          continue;
        }
      }
      clusterLeaves.push(base);
    }
    if (wantSha) allPairs.push(...sha256Pairs([leaf, ...clusterLeaves]));
    if (wantLesson) allPairs.push(...lessonKeyPairs([leaf, ...clusterLeaves]));
    if (wantSim) allPairs.push(...similarityPairs(leaf, clusterLeaves, simThreshold));
  }
  const pairs = dedupePairs(allPairs);
  for (const p of pairs) report.get(p.sourcePass).flagged++;
  return pairs;
}

// Archive a loser: stamp superseded_by + consolidated_at, then disable.
async function archiveLoser({ loser, keeperId, slot, deps, now, report, sourcePass, dryRun }) {
  if (dryRun) {
    report.get(sourcePass).archived++;
    return;
  }
  try {
    await deps.updateMeta({
      datasetId: slot,
      documentId: loser.documentId,
      metadata: stampMeta(loser, { superseded_by: keeperId, consolidated_at: toIso(now) }),
    });
    await deps.disableDoc({ documentId: loser.documentId, datasetId: slot });
    report.get(sourcePass).archived++;
  } catch (err) {
    report.get(sourcePass).errors++;
    process.stderr.write(`[consolidate] archive failed for ${loser.documentId} (${sourcePass}): ${err?.message || err}\n`);
  }
}

async function handlePairsNoLlm({ pairs, slot, deps, now, report, dryRun }) {
  const { deterministic, fuzzy } = partitionByArchivePolicy(pairs);
  // Fuzzy similarity: flag only (already counted in report.flagged); never
  // archive without LLM confirmation.
  for (const p of deterministic) {
    await archiveLoser({ loser: p.loser, keeperId: p.keeper.documentId, slot, deps, now, report, sourcePass: p.sourcePass, dryRun });
  }
  return fuzzy.length;
}

async function handlePairsWithLlm({ pairs, slot, deps, now, report, dryRun, ctx }) {
  const sys = loadPrompt("consolidate-merge.md");
  const cap = consolidateAtomBodyMaxChars();
  const mergeReport = report.get("llm-merge-near-duplicates");
  for (const p of pairs) {
    if (!ctx.llmEnabled) {
      // Provider died mid-run: fall back to the no-LLM policy for the rest.
      const { deterministic } = partitionByArchivePolicy([p]);
      for (const d of deterministic) {
        await archiveLoser({ loser: d.loser, keeperId: d.keeper.documentId, slot, deps, now, report, sourcePass: d.sourcePass, dryRun });
      }
      continue;
    }
    const user = JSON.stringify({
      source_pass: p.sourcePass,
      keeper: { documentId: p.keeper.documentId, created_at: new Date(p.keeper.createdAtMs).toISOString(), metadata: p.keeper.metadata, body: p.keeper.body || "" },
      loser: { documentId: p.loser.documentId, created_at: new Date(p.loser.createdAtMs).toISOString(), metadata: p.loser.metadata, body: p.loser.body || "" },
    });
    let decision;
    try {
      decision = await deps.llm({ systemPrompt: sys, userPrompt: user, maxTokens: 1200 });
    } catch (err) {
      if (err instanceof LLMProviderUnavailable) {
        ctx.llmEnabled = false;
        process.stderr.write(`[consolidate] LLM provider unavailable; remaining merges fall back to deterministic: ${err?.message || err}\n`);
        const { deterministic } = partitionByArchivePolicy([p]);
        for (const d of deterministic) {
          await archiveLoser({ loser: d.loser, keeperId: d.keeper.documentId, slot, deps, now, report, sourcePass: d.sourcePass, dryRun });
        }
        continue;
      }
      // Schema/parse failure: deterministic fallback (archive only if safe).
      mergeReport.errors++;
      const { deterministic } = partitionByArchivePolicy([p]);
      for (const d of deterministic) {
        await archiveLoser({ loser: d.loser, keeperId: d.keeper.documentId, slot, deps, now, report, sourcePass: d.sourcePass, dryRun });
      }
      continue;
    }
    // Hallucination guard.
    if (decision?.keeper_id !== p.keeper.documentId || decision?.loser_id !== p.loser.documentId) {
      mergeReport.errors++;
      process.stderr.write(`[consolidate] merge LLM emitted mismatched ids for ${p.keeper.documentId}|${p.loser.documentId}; treating as skip\n`);
      continue; // safest: leave both active
    }
    if (decision.action === "skip") {
      mergeReport.flagged++;
      continue;
    }
    // Allow-list the archive actions: callLLMWithRetry has no schema validation,
    // so an unexpected/typo'd action must NOT fall through and archive the loser.
    // Treat anything other than merge / keep-keeper-unchanged as a safe no-op.
    if (decision.action !== "merge" && decision.action !== "keep-keeper-unchanged") {
      mergeReport.errors++;
      process.stderr.write(`[consolidate] merge LLM returned unexpected action='${decision.action}' for ${p.keeper.documentId}|${p.loser.documentId}; leaving both active\n`);
      continue;
    }
    let keeperId = p.keeper.documentId;
    if (decision.action === "merge") {
      let body = String(decision.merged_body || "");
      if (!body) {
        mergeReport.errors++;
        continue;
      }
      if (body.length > cap) {
        body = body.slice(0, cap).replace(/\s+$/, "") + `\n\n[truncated by consolidate at ${toIso(now)} — merged_body exceeded MEMORY_CONSOLIDATE_ATOM_BODY_MAX_CHARS]\n`;
      }
      if (!dryRun) {
        try {
          const saved = await deps.saveDoc({ name: p.keeper.name, text: body, datasetId: slot, metadata: stampMeta(p.keeper, { consolidated_at: toIso(now) }) });
          keeperId = requireNewId(saved, `merge keeper ${p.keeper.documentId}`);
          mergeReport.merged++;
        } catch (err) {
          mergeReport.errors++;
          process.stderr.write(`[consolidate] merge-write failed for keeper=${p.keeper.documentId}: ${err?.message || err}\n`);
          // Do NOT archive the loser: the merged body never landed, so archiving
          // it would drop its unique content. Leave both active; retry next run.
          continue;
        }
      } else {
        mergeReport.merged++;
      }
    }
    // merge + keep-keeper-unchanged both archive the loser (against the
    // post-rewrite keeper id when a merge happened).
    await archiveLoser({ loser: p.loser, keeperId, slot, deps, now, report, sourcePass: p.sourcePass, dryRun });
  }
}

// ─── staleness + refresh ──────────────────────────────────────────────────────

async function runStalenessFlag({ leaves, slot, deps, now, report, dryRun }) {
  const r = report.get("staleness-flag");
  const months = consolidateStaleAfterMonths();
  for (const leaf of leaves) {
    const stale = isStale(leaf, nowMs(now), months);
    const cur = String(leaf.metadata?.stale || "") === "true";
    if (stale === cur) continue;
    r.touched++;
    if (!dryRun) {
      try {
        await deps.updateMeta({ datasetId: slot, documentId: leaf.documentId, metadata: stampMeta(leaf, { stale: stale ? "true" : "false" }) });
      } catch (err) {
        r.errors++;
        process.stderr.write(`[consolidate] staleness stamp failed for ${leaf.documentId}: ${err?.message || err}\n`);
      }
    }
  }
}

async function runSemanticRefresh({ leaves, slot, deps, now, report, dryRun, ctx, topK, clusterScore }) {
  const r = report.get("llm-semantic-refresh");
  const cap = consolidateAtomBodyMaxChars();
  const months = consolidateStaleAfterMonths();
  const limit = consolidateRefreshMaxPerRun();
  const sys = loadPrompt("consolidate-refresh.md");

  let stale = staleCandidates(leaves, nowMs(now), months);
  stale.sort((a, b) => {
    const aMs = Date.parse(a.metadata?.last_recalled_at || "") || 0;
    const bMs = Date.parse(b.metadata?.last_recalled_at || "") || 0;
    if (aMs !== bMs) return bMs - aMs;
    return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
  });
  if (stale.length > limit) {
    process.stderr.write(`[consolidate] refresh capped at ${limit}/run; ${stale.length - limit} stale docs deferred\n`);
    stale = stale.slice(0, limit);
  }

  for (const leaf of stale) {
    if (!ctx.llmEnabled) break;
    let body = leaf.body;
    let cluster;
    try {
      if (body === undefined) body = await deps.readBody({ documentId: leaf.documentId, datasetId: slot });
      cluster = await deps.searchSimilar({ query: String(body).slice(0, DIFY_QUERY_MAX_CHARS), datasetId: slot, limit: topK, scoreThreshold: clusterScore });
    } catch (err) {
      r.errors++;
      process.stderr.write(`[consolidate] refresh cluster failed for ${leaf.documentId}: ${err?.message || err}\n`);
      continue;
    }
    const clusterBundle = (cluster?.records || [])
      .filter((rec) => rec.documentId !== leaf.documentId)
      .slice(0, topK)
      .map((rec, i) => ({ n: i + 1, documentId: rec.documentId, score: Number(rec.score?.toFixed?.(4) ?? rec.score), content: String(rec.content || "").slice(0, 600) }));
    const lastRecalled = leaf.metadata?.last_recalled_at || "";
    // Guard against an unparseable last_recalled_at: Date.parse -> NaN would
    // serialize to null in the prompt JSON (schema expects a number or "never").
    let daysSinceRecall = "never";
    if (lastRecalled) {
      const t = Date.parse(lastRecalled);
      if (Number.isFinite(t)) daysSinceRecall = Math.max(0, Math.round((nowMs(now) - t) / 86_400_000));
    }
    const user = JSON.stringify({
      document: { documentId: leaf.documentId, created_at: new Date(leaf.createdAtMs).toISOString(), last_recalled_at: lastRecalled || "never", daysSinceRecall, metadata: leaf.metadata, body: String(body || "") },
      cluster: clusterBundle,
    });

    let decision;
    try {
      decision = await deps.llm({ systemPrompt: sys, userPrompt: user, maxTokens: 1200 });
    } catch (err) {
      if (err instanceof LLMProviderUnavailable) {
        ctx.llmEnabled = false;
        process.stderr.write(`[consolidate] LLM provider unavailable; refresh halted: ${err?.message || err}\n`);
        break;
      }
      r.errors++;
      continue; // leave stale flag in place
    }
    if (decision?.leaf_id !== leaf.documentId) {
      r.errors++;
      continue;
    }
    if (dryRun) {
      if (decision.action === "rewrite") r.refreshed++;
      else if (decision.action === "archive") r.archived++;
      else r.touched++;
      continue;
    }
    try {
      if (decision.action === "keep") {
        // Only CLEAR the stale flag when the model EXPLICITLY says stale_after:false.
        // A missing/invalid stale_after must NOT unintentionally clear it (callLLMWithRetry
        // does not validate the schema) -- default to leaving it stale for a later revisit.
        const staleAfter = decision.stale_after === false ? "false" : "true";
        await deps.updateMeta({ datasetId: slot, documentId: leaf.documentId, metadata: stampMeta(leaf, { stale: staleAfter }) });
        r.touched++;
      } else if (decision.action === "rewrite") {
        let nb = String(decision.rewritten_body || "");
        if (!nb) {
          r.errors++;
          continue;
        }
        if (nb.length > cap) nb = nb.slice(0, cap).replace(/\s+$/, "") + `\n\n[truncated by consolidate at ${toIso(now)}]\n`;
        await deps.saveDoc({ name: leaf.name, text: nb, datasetId: slot, metadata: stampMeta(leaf, { stale: "false", last_refreshed_at: toIso(now), consolidated_at: toIso(now) }) });
        r.refreshed++;
      } else if (decision.action === "archive") {
        // An archive IS a stale outcome (per the prompt: stale_after=true for archive),
        // so stamp stale=true for consistency/forensics even though the doc is disabled.
        await deps.updateMeta({ datasetId: slot, documentId: leaf.documentId, metadata: stampMeta(leaf, { stale: "true", consolidated_at: toIso(now) }) });
        await deps.disableDoc({ documentId: leaf.documentId, datasetId: slot });
        r.archived++;
      }
    } catch (err) {
      r.errors++;
      process.stderr.write(`[consolidate] refresh apply failed for ${leaf.documentId} (${decision.action}): ${err?.message || err}\n`);
    }
  }
}

async function runCompressArchived({ disabled, slot, deps, now, report, dryRun }) {
  const r = report.get("compress-archived");
  const bodyMax = consolidateArchiveBodyMax();
  const ageDays = consolidateArchiveAgeDays();
  // Fetch bodies for disabled docs, then filter via the pure predicate.
  for (const leaf of disabled) {
    if (leaf.metadata?.consolidate_truncated_at) continue;
    try {
      if (leaf.body === undefined) leaf.body = await deps.readBody({ documentId: leaf.documentId, datasetId: slot });
    } catch {
      continue;
    }
  }
  const candidates = compressCandidates(disabled, nowMs(now), { bodyMax, archiveAgeDays: ageDays });
  for (const leaf of candidates) {
    const oldLen = String(leaf.body).length;
    const truncated = String(leaf.body).slice(0, bodyMax).replace(/\s+$/, "") + `\n\n[archived body truncated by consolidate at ${toIso(now)}]\n`;
    if (dryRun) {
      r.touched++;
      r.freedBytes += Math.max(0, oldLen - truncated.length);
      continue;
    }
    try {
      // saveDoc is upsert-by-name: it CREATES a new document id and deletes the
      // old one. So we must disable the NEW id to keep the doc archived;
      // disabling leaf.documentId (now deleted) would fail and leave the
      // truncated doc ENABLED (un-archiving it). Capture the new id from saveDoc.
      const saved = await deps.saveDoc({ name: leaf.name, text: truncated, datasetId: slot, metadata: stampMeta(leaf, { consolidate_truncated_at: toIso(now) }) });
      const newId = saved?.id;
      if (!newId) throw new Error(`compress: saveDoc returned no document id for ${leaf.documentId}`);
      await deps.disableDoc({ documentId: newId, datasetId: slot });
      r.touched++;
      r.freedBytes += Math.max(0, oldLen - truncated.length);
    } catch (err) {
      r.errors++;
      process.stderr.write(`[consolidate] compress failed for ${leaf.documentId}: ${err?.message || err}\n`);
    }
  }
}

// ─── entry point ───────────────────────────────────────────────────────────

export async function consolidateMemory({ dryRun = false, ifDue = false, force = false, llm = true, passes, now, deps, onlyDataset } = {}) {
  const startMs = Date.now();
  const D = deps || defaultDeps();
  const allowed = resolveAllowedPasses(passes);
  const llmRequested = consolidateLlmEnabled() && llm !== false;

  // 1. Policy gate: refuse on any undeclared bound slot. When `onlyDataset` is
  // given (an id or slot name), scope the run to JUST that dataset and bypass
  // policy resolution (used for targeted runs / testing a single dataset; a raw
  // dataset id is resolved directly by the bridge).
  const env = D.loadEnv();
  let policies, refine, refusals;
  if (onlyDataset) {
    refine = [onlyDataset];
    policies = { [onlyDataset]: "refine" };
    refusals = [];
  } else {
    ({ policies, refine, refusals } = resolveAllPolicies(env));
  }
  if (refusals.length > 0) {
    return {
      ok: false,
      error: "policy-undeclared-slot",
      message:
        "Each bound dataset slot must declare MEMORY_CONSOLIDATE_<SLOT>=refine|none (or use a built-in default). " +
        "Undeclared: " + refusals.map((r) => `${r.slot} (set ${r.envKey})`).join(", "),
      refusals,
      llmRequested,
      llm: false,
    };
  }

  // 2. Throttle (rolling window).
  if (ifDue && !force) {
    const cadenceDays = consolidateIntervalDays();
    const state = D.readState();
    const last = state?.last_run_utc ? Date.parse(state.last_run_utc) : 0;
    if (Number.isFinite(last) && last > 0) {
      const ageDays = (nowMs(now) - last) / 86_400_000;
      if (ageDays < cadenceDays) {
        return { ok: true, skipped: "not-due", lastRunUtc: state.last_run_utc, cadenceDays, ageDays, llmRequested, llm: false };
      }
    }
  }

  // 3. Lock (shared with compile so the two never race / share one LLM window).
  // A held lock is a BENIGN skip (compile or another consolidate is running),
  // not a failure: return ok:true so the CLI exits 0 and the hourly cron does
  // not record a false failure / flip cron-health to unhealthy. The next tick
  // retries once the lock frees.
  const lock = D.acquireLock();
  if (!lock.ok) {
    return { ok: true, skipped: "locked-by", reason: lock.reason, owner: lock.owner, llmRequested, llm: false };
  }

  const ctx = { llmEnabled: llmRequested };
  const report = new Map(ALL_PASS_NAMES.map((n) => [n, emptyReport(n)]));
  const simThreshold = consolidateSimilarityThreshold();
  const topK = consolidateClusterTopK();
  const clusterScore = consolidateClusterScoreThreshold();
  let workingSetSize = 0;
  // Slot-level failures (e.g. list-consolidate threw) are NOT pass-specific;
  // count them once here rather than incrementing every pass report (which would
  // multiply a single failure by the pass count in totals.errors).
  let slotErrors = 0;

  try {
    for (const slot of refine) {
      let rows;
      try {
        const r = await D.listForConsolidate({ datasetId: slot });
        rows = Array.isArray(r?.documents) ? r.documents : [];
      } catch (err) {
        process.stderr.write(`[consolidate] list-consolidate failed for slot=${slot}: ${err?.message || err}\n`);
        slotErrors += 1;
        continue;
      }
      const all = rows.map((row) => toLeaf(row, slot));
      const active = all.filter((l) => l.enabled);
      const disabled = all.filter((l) => !l.enabled);
      workingSetSize += active.length;

      // Dedup -> merge/archive.
      if (allowed.has(SOURCE_PASSES.SHA256) || allowed.has(SOURCE_PASSES.LESSON_KEY) || allowed.has(SOURCE_PASSES.SIMILARITY)) {
        const pairs = await buildPairsForSlot({ slot, leaves: active, allowed, deps: D, simThreshold, topK, clusterScore, report });
        if (ctx.llmEnabled && allowed.has("llm-merge-near-duplicates")) {
          await handlePairsWithLlm({ pairs, slot, deps: D, now, report, dryRun, ctx });
        } else {
          handleNoLlmCounts(await handlePairsNoLlm({ pairs, slot, deps: D, now, report, dryRun }));
        }
      }

      // Staleness flag + refresh.
      if (allowed.has("staleness-flag")) {
        await runStalenessFlag({ leaves: active, slot, deps: D, now, report, dryRun });
      }
      if (ctx.llmEnabled && allowed.has("llm-semantic-refresh")) {
        await runSemanticRefresh({ leaves: active, slot, deps: D, now, report, dryRun, ctx, topK, clusterScore });
      }

      // Compress archived.
      if (allowed.has("compress-archived")) {
        await runCompressArchived({ disabled, slot, deps: D, now, report, dryRun });
      }
    }
  } finally {
    try {
      lock.release && lock.release();
    } catch {
      /* best-effort */
    }
  }

  const totals = { archived: 0, merged: 0, refreshed: 0, flagged: 0, touched: 0, errors: slotErrors, freedBytes: 0 };
  for (const rep of report.values()) {
    totals.archived += rep.archived;
    totals.merged += rep.merged;
    totals.refreshed += rep.refreshed;
    totals.flagged += rep.flagged;
    totals.touched += rep.touched;
    totals.errors += rep.errors;
    totals.freedBytes += rep.freedBytes;
  }

  const result = {
    ok: true,
    dryRun: Boolean(dryRun),
    llm: ctx.llmEnabled,
    llmRequested,
    policies,
    refine,
    workingSetSize,
    passes: Object.fromEntries(report),
    totals,
  };
  if (!dryRun) {
    D.writeState({ last_run_utc: toIso(now), durationMs: Date.now() - startMs, dryRun: false, totals, passes: Object.fromEntries(report) });
  }
  return result;
}

// fuzzy-flag-only count is already reflected in report.flagged; this hook exists
// so a future caller could surface "N flagged-not-archived" explicitly.
function handleNoLlmCounts(_fuzzyCount) {
  /* no-op: fuzzy pairs were counted in report.flagged at build time */
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { dryRun: false, ifDue: false, force: false, llm: true, json: false, passes: undefined, onlyDataset: undefined, unknown: [] };
  for (const a of argv) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--if-due") out.ifDue = true;
    else if (a === "--force") out.force = true;
    else if (a === "--no-llm") out.llm = false;
    else if (a === "--json") out.json = true;
    else if (a.startsWith("--passes=")) out.passes = a.slice("--passes=".length);
    else if (a.startsWith("--only-dataset=")) out.onlyDataset = a.slice("--only-dataset=".length);
    else out.unknown.push(a); // unrecognised: surfaced by the caller (don't silently ignore a typo)
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.unknown.length) {
    process.stderr.write(`consolidate: ignoring unknown argument(s): ${args.unknown.join(", ")} (valid: --dry-run --if-due --force --no-llm --json --passes=<csv> --only-dataset=<id>)\n`);
  }
  const result = await consolidateMemory({ dryRun: args.dryRun, ifDue: args.ifDue, force: args.force, llm: args.llm, passes: args.passes, onlyDataset: args.onlyDataset });
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    const t = result.totals || {};
    process.stderr.write(
      `consolidate: ok=${result.ok} dryRun=${result.dryRun} llm=${result.llm} refine=[${(result.refine || []).join(",")}] ` +
        `working=${result.workingSetSize ?? 0} archived=${t.archived ?? 0} merged=${t.merged ?? 0} refreshed=${t.refreshed ?? 0} flagged=${t.flagged ?? 0} errors=${t.errors ?? 0}\n`,
    );
    if (result.error) process.stderr.write(`consolidate: ${result.error}: ${result.message}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  await main();
}
