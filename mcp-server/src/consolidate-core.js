// Pure analysis core for the consolidate orchestrator.
//
// No I/O, no LLM, no Dify import: given already-fetched documents (and, for the
// similarity pass, an already-scored candidate list), it produces dedup pairs,
// keeper selection, staleness verdicts, and compress candidates. Both runtimes
// import it: the host engine (scripts/consolidate.mjs) adds the LLM merge/refresh
// and the Dify writes; the read-only MCP projector (consolidate_memory) wraps it
// in Dify reads to return a dry-run projection. Living under mcp-server/src keeps
// it visible to the container (which mounts only that dir), mirroring the repo's
// slug.js/slug.mjs + schema.js/datasets.mjs dual-runtime split.
//
// Leaf shape (what callers pass in):
//   {
//     documentId: string,
//     name: string,
//     category: string,          // dataset slot
//     createdAtMs: number,       // epoch ms (Dify created_at seconds * 1000)
//     enabled: boolean,
//     metadata: { atom_type, error_pattern, project_module, task_type,
//                 last_recalled_at, stale, consolidate_truncated_at, ... },
//     body?: string,             // fetched lazily; required for sha256 + compress
//   }

import crypto from "node:crypto";

export const SOURCE_PASSES = Object.freeze({
  SHA256: "dedupe-by-sha256",
  LESSON_KEY: "dedupe-by-lesson-key",
  SIMILARITY: "dedupe-by-similarity",
});

// Precedence when the same loser is flagged by multiple passes: an exact-hash
// duplicate outranks a lesson-key duplicate, which outranks a fuzzy match.
const PASS_PRECEDENCE = [SOURCE_PASSES.SHA256, SOURCE_PASSES.LESSON_KEY, SOURCE_PASSES.SIMILARITY];
function passRank(p) {
  const i = PASS_PRECEDENCE.indexOf(p);
  return i === -1 ? PASS_PRECEDENCE.length : i;
}

// Pairs from these passes may be archived deterministically WITHOUT an LLM
// (byte-identical, or the same canonical lesson key — both safe). Fuzzy
// similarity is deliberately excluded: without an LLM to confirm the match, a
// similar-but-distinct doc must NOT be archived (decision 11 — flag only).
export const DETERMINISTIC_ARCHIVE_PASSES = new Set([
  SOURCE_PASSES.SHA256,
  SOURCE_PASSES.LESSON_KEY,
]);

// atom_types whose lesson-key (project_module|task_type|error_pattern) is a
// meaningful cross-doc dedup key. self-improvement-lesson is the canonical case.
export const LESSON_KEY_ELIGIBLE_ATOM_TYPES = new Set(["self-improvement-lesson"]);

// atom_types eligible for staleness flagging + LLM refresh. Durable records
// (decision / reference / project-lore / plan) are intentionally excluded.
export const STALENESS_ELIGIBLE_ATOM_TYPES = new Set([
  "self-improvement-lesson",
  "bug-root-cause",
  "feedback-rule",
  "pattern-gotcha",
]);

const MS_PER_MONTH = 30.4375 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function contentHash(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

// Canonical lesson key (project_module | task_type | error_pattern). Returns ""
// (sentinel: skip) unless ALL THREE parts are present: a partial key would
// collapse unrelated lessons (e.g. "|debug|flaky" with an empty project_module),
// making lesson-key dedup dangerously over-aggressive. Docs missing these fields
// are surfaced separately by audit_memory's missing-metadata class.
export function lessonKey(leaf) {
  const m = leaf?.metadata || {};
  const ep = String(m.error_pattern || "").trim().toLowerCase();
  const pm = String(m.project_module || "").trim().toLowerCase();
  const tt = String(m.task_type || "").trim().toLowerCase();
  if (!ep || !pm || !tt) return "";
  return `${pm}|${tt}|${ep}`;
}

// Keeper selection: newest createdAtMs wins (Dify has no `updated` field);
// tiebreak lex-ascending documentId so two runs on the same data pick identically.
export function pickKeeper(a, b) {
  const ac = Number(a?.createdAtMs) || 0;
  const bc = Number(b?.createdAtMs) || 0;
  if (ac > bc) return a;
  if (bc > ac) return b;
  return String(a?.documentId) < String(b?.documentId) ? a : b;
}

function groupBy(leaves, keyFn) {
  const groups = new Map();
  for (const leaf of leaves) {
    const k = keyFn(leaf);
    if (k == null || k === "") continue;
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(leaf);
  }
  return groups;
}

// For each group of >= 2, the group-wide keeper (pickKeeper reduced) is kept and
// every other member becomes a (keeper, loser) pair.
function pairsFromGroups(groups, sourcePass) {
  const pairs = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    let keeper = group[0];
    for (let i = 1; i < group.length; i += 1) keeper = pickKeeper(keeper, group[i]);
    for (const leaf of group) {
      if (leaf.documentId === keeper.documentId) continue;
      pairs.push({ keeper, loser: leaf, sourcePass });
    }
  }
  return pairs;
}

// Exact byte-equal duplicates. Requires leaf.body; leaves without a body are skipped.
export function sha256Pairs(leaves) {
  const withBody = (leaves || []).filter((l) => l && l.body != null);
  return pairsFromGroups(groupBy(withBody, (l) => contentHash(l.body)), SOURCE_PASSES.SHA256);
}

// Same-lesson-key duplicates (atom-type-gated; needs no body).
export function lessonKeyPairs(leaves) {
  const eligible = (leaves || []).filter((l) =>
    LESSON_KEY_ELIGIBLE_ATOM_TYPES.has(String(l?.metadata?.atom_type || "")),
  );
  return pairsFromGroups(groupBy(eligible, lessonKey), SOURCE_PASSES.LESSON_KEY);
}

// Fuzzy near-duplicates for ONE query leaf against its already-scored cluster.
// `candidates` are leaves each carrying a `.score` (Dify hybrid score). A pair
// is flagged when score >= threshold. Keeper chosen by createdAtMs as elsewhere.
export function similarityPairs(queryLeaf, candidates, threshold) {
  const pairs = [];
  for (const cand of candidates || []) {
    if (!cand || cand.documentId === queryLeaf.documentId) continue;
    if (!(Number(cand.score) >= threshold)) continue;
    const keeper = pickKeeper(queryLeaf, cand);
    const loser = keeper.documentId === queryLeaf.documentId ? cand : queryLeaf;
    pairs.push({ keeper, loser, sourcePass: SOURCE_PASSES.SIMILARITY, score: Number(cand.score) });
  }
  return pairs;
}

// Collapse a flat pair list to at most one pair per loser (highest-precedence
// sourcePass wins) and drop any pair whose keeper is itself archived as a loser
// elsewhere (so we never rewrite-then-archive the same doc). Deterministic order.
export function dedupePairs(pairs) {
  const byLoser = new Map();
  for (const p of pairs || []) {
    const id = p?.loser?.documentId;
    if (!id) continue;
    const prev = byLoser.get(id);
    if (!prev || passRank(p.sourcePass) < passRank(prev.sourcePass)) byLoser.set(id, p);
  }
  const losers = new Set(byLoser.keys());
  const out = [];
  for (const p of byLoser.values()) {
    if (losers.has(p.keeper.documentId)) continue;
    out.push(p);
  }
  out.sort((a, b) => (a.loser.documentId < b.loser.documentId ? -1 : a.loser.documentId > b.loser.documentId ? 1 : 0));
  return out;
}

// Split deduped pairs by how they are handled when NO LLM is available.
//   deterministic: archivable without confirmation (sha256 / lesson-key)
//   fuzzy:         flag-only without an LLM (similarity)
export function partitionByArchivePolicy(pairs) {
  const deterministic = [];
  const fuzzy = [];
  for (const p of pairs || []) {
    if (DETERMINISTIC_ARCHIVE_PASSES.has(p.sourcePass)) deterministic.push(p);
    else fuzzy.push(p);
  }
  return { deterministic, fuzzy };
}

// Last activity = max(last_recalled_at, createdAt). A recently-recalled old doc
// is NOT stale (the recall refreshes activity); an old, never-recalled doc is.
export function lastActivityMs(leaf) {
  const m = leaf?.metadata || {};
  const recalled = m.last_recalled_at ? Date.parse(m.last_recalled_at) : NaN;
  const created = Number(leaf?.createdAtMs) || 0;
  return Number.isFinite(recalled) ? Math.max(recalled, created) : created;
}

// Deterministic staleness verdict. eligible atom_type + last activity older than
// staleAfterMonths. Unknown age (0) is treated as not-stale (conservative).
export function isStale(leaf, nowMs, staleAfterMonths) {
  if (!STALENESS_ELIGIBLE_ATOM_TYPES.has(String(leaf?.metadata?.atom_type || ""))) return false;
  const last = lastActivityMs(leaf);
  if (!last) return false;
  return (nowMs - last) / MS_PER_MONTH > staleAfterMonths;
}

export function staleCandidates(leaves, nowMs, staleAfterMonths) {
  return (leaves || []).filter((l) => isStale(l, nowMs, staleAfterMonths));
}

// Disabled (archived) leaves whose body is over the cap and that have aged past
// archiveAgeDays and have not already been truncated. Requires leaf.body.
export function compressCandidates(disabledLeaves, nowMs, { bodyMax, archiveAgeDays }) {
  return (disabledLeaves || []).filter((l) => {
    if (!l || l.body == null) return false;
    if (l.metadata?.consolidate_truncated_at) return false;
    if (String(l.body).length <= bodyMax) return false;
    const created = Number(l.createdAtMs) || 0;
    if (!created) return false;
    return (nowMs - created) / MS_PER_DAY > archiveAgeDays;
  });
}

export function emptyTotals() {
  return { archived: 0, merged: 0, refreshed: 0, flagged: 0, touched: 0, errors: 0, freedBytes: 0 };
}
