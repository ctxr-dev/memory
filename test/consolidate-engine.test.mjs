// Lock the consolidate host engine with injected fakes (no real bridge / LLM).
// Focus: merge rewrites the keeper and points the loser's superseded_by at the
// POST-rewrite keeper id; the no-LLM policy archives exact/lesson-key losers but
// only FLAGS fuzzy ones; dry-run performs zero writes; an undeclared slot refuses.

import { test } from "node:test";
import assert from "node:assert/strict";

import { consolidateMemory } from "../scripts/consolidate.mjs";

const SEC = 1; // createdAt in seconds
const NOW = new Date("2026-06-03T00:00:00Z");
const MONTH_SEC = 2_629_800; // ~30.4 days in seconds
const nowSec = Math.floor(NOW.getTime() / 1000);

// Build an injectable deps object backed by in-memory slot documents.
function makeDeps({ slotsDocs, env, scoreMap = {}, mergeResponder, refreshResponder, failLlm, failSearch, failList }) {
  const calls = { saveDoc: [], disableDoc: [], updateMeta: [], llm: [], list: [], searchQueries: [] };
  let saveN = 0;
  let stateValue = null;
  const allDocs = () => Object.values(slotsDocs).flat();
  const bodyOf = (id) => allDocs().find((d) => d.documentId === id)?.body ?? "";

  const deps = {
    loadEnv: () => env,
    acquireLock: () => ({ ok: true, release() {} }),
    readState: () => stateValue,
    writeState: (s) => { stateValue = s; },
    listForConsolidate: async ({ datasetId }) => {
      calls.list.push(datasetId);
      if (failList) throw new Error("list down");
      const docs = (slotsDocs[datasetId] || []).map((d) => ({
        documentId: d.documentId,
        name: d.name,
        enabled: d.enabled !== false,
        createdAt: d.createdAtSec,
        metadata: d.metadata || {},
      }));
      return { documents: docs };
    },
    readBody: async ({ documentId }) => bodyOf(documentId),
    searchSimilar: async ({ datasetId, query }) => {
      calls.searchQueries.push(query);
      if (failSearch) throw new Error("search down");
      const docs = (slotsDocs[datasetId] || []).filter((d) => d.enabled !== false);
      // Tolerant reverse-lookup: the engine caps the query to a prefix of the
      // body, so match on prefix in either direction.
      const queryId = docs.find((d) => String(d.body).startsWith(query) || query.startsWith(String(d.body)))?.documentId;
      const records = [];
      for (const d of docs) {
        if (d.documentId === queryId) continue;
        const key = [queryId, d.documentId].sort().join("|");
        const score = key in scoreMap ? scoreMap[key] : 0.3; // default below similarity threshold
        records.push({ documentId: d.documentId, score, content: d.body });
      }
      return { records };
    },
    saveDoc: async ({ name, text, datasetId, metadata }) => {
      const id = `save-${++saveN}`;
      calls.saveDoc.push({ id, name, text, datasetId, metadata });
      return { id };
    },
    disableDoc: async ({ documentId }) => { calls.disableDoc.push(documentId); },
    updateMeta: async ({ documentId, metadata }) => { calls.updateMeta.push({ documentId, metadata }); },
    llm: async ({ systemPrompt, userPrompt }) => {
      calls.llm.push({ systemPrompt, userPrompt });
      if (failLlm) {
        const { LLMProviderUnavailable } = await import("../scripts/lib/llm.mjs");
        throw new LLMProviderUnavailable("fake provider down");
      }
      const obj = JSON.parse(userPrompt);
      if (/semantic-refresh/.test(systemPrompt)) return refreshResponder(obj);
      return mergeResponder(obj);
    },
  };
  return { deps, calls };
}

const KNOWLEDGE_ENV = { DIFY_DATASET_KNOWLEDGE_ID: "k" };

test("merge: keeper rewritten; loser superseded_by points at the POST-rewrite keeper id", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "old", name: "dup.md", createdAtSec: nowSec - 100, metadata: { atom_type: "decision" }, body: "same body" },
      { documentId: "new", name: "dup.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "same body" },
    ],
  };
  const { deps, calls } = makeDeps({
    slotsDocs,
    env: KNOWLEDGE_ENV,
    mergeResponder: (o) => ({ action: "merge", merged_body: "merged!", keeper_id: o.keeper.documentId, loser_id: o.loser.documentId, reason: "x" }),
    refreshResponder: () => ({}),
  });
  const res = await consolidateMemory({ now: NOW, passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"], deps });
  assert.equal(res.ok, true);
  assert.equal(calls.saveDoc.length, 1, "keeper rewritten once");
  const newKeeperId = calls.saveDoc[0].id;
  // loser is "old" (keeper is newer "new"); its superseded_by must be the NEW id
  const stamp = calls.updateMeta.find((u) => u.documentId === "old");
  assert.ok(stamp, "loser stamped");
  assert.equal(stamp.metadata.superseded_by, newKeeperId);
  assert.deepEqual(calls.disableDoc, ["old"]);
  assert.equal(res.totals.merged, 1);
  assert.equal(res.totals.archived, 1);
});

test("keep-keeper-unchanged: no keeper rewrite; loser archived against the original keeper id", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "old", name: "dup.md", createdAtSec: nowSec - 100, metadata: { atom_type: "decision", custom_extra: "keepme", document_name: "dup.md" }, body: "same body" },
      { documentId: "new", name: "dup.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "same body" },
    ],
  };
  const { deps, calls } = makeDeps({
    slotsDocs,
    env: KNOWLEDGE_ENV,
    mergeResponder: (o) => ({ action: "keep-keeper-unchanged", keeper_id: o.keeper.documentId, loser_id: o.loser.documentId, reason: "x" }),
    refreshResponder: () => ({}),
  });
  const res = await consolidateMemory({ now: NOW, passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"], deps });
  assert.equal(calls.saveDoc.length, 0, "keeper not rewritten");
  const stamp = calls.updateMeta.find((u) => u.documentId === "old");
  assert.equal(stamp.metadata.superseded_by, "new");
  assert.equal(stamp.metadata.atom_type, "decision", "existing metadata preserved on the stamp (Dify replaces the full set)");
  assert.equal(stamp.metadata.custom_extra, "keepme", "non-allowlisted custom field preserved");
  assert.equal("document_name" in stamp.metadata, false, "Dify built-in not echoed back");
  assert.deepEqual(calls.disableDoc, ["old"]);
  assert.equal(res.totals.merged, 0);
  assert.equal(res.totals.archived, 1);
});

test("skip: neither doc archived", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "a", name: "a.md", createdAtSec: nowSec - 100, metadata: { atom_type: "decision" }, body: "same body" },
      { documentId: "b", name: "b.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "same body" },
    ],
  };
  const { deps, calls } = makeDeps({
    slotsDocs,
    env: KNOWLEDGE_ENV,
    mergeResponder: (o) => ({ action: "skip", keeper_id: o.keeper.documentId, loser_id: o.loser.documentId, reason: "different" }),
    refreshResponder: () => ({}),
  });
  const res = await consolidateMemory({ now: NOW, passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"], deps });
  assert.equal(calls.disableDoc.length, 0);
  assert.equal(calls.saveDoc.length, 0);
  assert.equal(res.totals.archived, 0);
});

test("no-LLM: exact dup archived; fuzzy similarity flagged-only (never archived)", async () => {
  const slotsDocs = {
    knowledge: [
      // exact pair (sha256)
      { documentId: "ex1", name: "ex1.md", createdAtSec: nowSec - 10, metadata: { atom_type: "decision" }, body: "identical text" },
      { documentId: "ex2", name: "ex2.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "identical text" },
      // fuzzy pair (distinct bodies, high score)
      { documentId: "fz1", name: "fz1.md", createdAtSec: nowSec - 10, metadata: { atom_type: "decision" }, body: "alpha distinct one" },
      { documentId: "fz2", name: "fz2.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "beta distinct two" },
    ],
  };
  const scoreMap = { ["fz1|fz2"]: 0.95 }; // only the fuzzy pair is similar enough
  const { deps, calls } = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, scoreMap, mergeResponder: () => ({}), refreshResponder: () => ({}) });
  const res = await consolidateMemory({ now: NOW, llm: false, passes: ["dedupe-by-sha256", "dedupe-by-similarity"], deps });
  // exact loser archived; fuzzy NOT archived
  assert.deepEqual(calls.disableDoc, ["ex1"]);
  assert.equal(res.passes["dedupe-by-sha256"].archived, 1);
  assert.equal(res.passes["dedupe-by-similarity"].archived, 0);
  assert.ok(res.passes["dedupe-by-similarity"].flagged >= 1, "fuzzy pair flagged");
});

test("dry-run: zero writes, projection still counts", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "old", name: "dup.md", createdAtSec: nowSec - 100, metadata: { atom_type: "decision" }, body: "same body" },
      { documentId: "new", name: "dup.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "same body" },
    ],
  };
  const { deps, calls } = makeDeps({
    slotsDocs,
    env: KNOWLEDGE_ENV,
    mergeResponder: (o) => ({ action: "merge", merged_body: "merged!", keeper_id: o.keeper.documentId, loser_id: o.loser.documentId, reason: "x" }),
    refreshResponder: () => ({}),
  });
  const res = await consolidateMemory({ now: NOW, dryRun: true, passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"], deps });
  assert.equal(calls.saveDoc.length, 0);
  assert.equal(calls.disableDoc.length, 0);
  assert.equal(calls.updateMeta.length, 0);
  assert.equal(res.dryRun, true);
  assert.equal(res.totals.merged, 1);
  assert.equal(res.totals.archived, 1);
});

test("undeclared bound slot refuses before any list/write", async () => {
  const { deps, calls } = makeDeps({
    slotsDocs: { knowledge: [], runbooks: [] },
    env: { DIFY_DATASET_KNOWLEDGE_ID: "k", DIFY_DATASET_RUNBOOKS_ID: "r" },
    mergeResponder: () => ({}),
    refreshResponder: () => ({}),
  });
  const res = await consolidateMemory({ now: NOW, deps });
  assert.equal(res.ok, false);
  assert.equal(res.error, "policy-undeclared-slot");
  assert.ok(res.refusals.some((r) => r.slot === "runbooks"));
  assert.equal(calls.list.length, 0, "no listing after refusal");
});

test("staleness-flag: stamps stale=true on an old never-recalled lesson", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "stale1", name: "s.md", createdAtSec: nowSec - 9 * MONTH_SEC, metadata: { atom_type: "self-improvement-lesson" }, body: "rule" },
    ],
  };
  const { deps, calls } = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, mergeResponder: () => ({}), refreshResponder: () => ({}) });
  const res = await consolidateMemory({ now: NOW, llm: false, passes: ["staleness-flag"], deps });
  const stamp = calls.updateMeta.find((u) => u.documentId === "stale1");
  assert.ok(stamp, "stale doc stamped");
  assert.equal(stamp.metadata.stale, "true");
  assert.equal(stamp.metadata.atom_type, "self-improvement-lesson", "existing metadata preserved on the stale stamp");
  assert.equal(res.passes["staleness-flag"].touched, 1);
});

test("refresh: archive disables the doc; rewrite saves a new body", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "obsolete", name: "o.md", createdAtSec: nowSec - 12 * MONTH_SEC, metadata: { atom_type: "feedback-rule" }, body: "old rule" },
    ],
  };
  // archive path
  let r1 = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, mergeResponder: () => ({}), refreshResponder: (o) => ({ action: "archive", leaf_id: o.document.documentId, archive_reason: "gone", stale_after: true, reason: "obsolete" }) });
  let res = await consolidateMemory({ now: NOW, passes: ["llm-semantic-refresh"], deps: r1.deps });
  assert.deepEqual(r1.calls.disableDoc, ["obsolete"]);
  assert.equal(res.passes["llm-semantic-refresh"].archived, 1);

  // rewrite path
  let r2 = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, mergeResponder: () => ({}), refreshResponder: (o) => ({ action: "rewrite", leaf_id: o.document.documentId, rewritten_body: "fresh rule", stale_after: false, reason: "drifted" }) });
  res = await consolidateMemory({ now: NOW, passes: ["llm-semantic-refresh"], deps: r2.deps });
  assert.equal(r2.calls.saveDoc.length, 1);
  assert.equal(r2.calls.saveDoc[0].metadata.stale, "false");
  assert.ok(r2.calls.saveDoc[0].metadata.last_refreshed_at);
  assert.equal(res.passes["llm-semantic-refresh"].refreshed, 1);
});

test("cluster query is capped under Dify's 250-char limit even for long bodies", async () => {
  // Regression: Dify's retrieval rejects a query > 250 chars (the error lands
  // in the per-dataset errors array, NOT as a throw), so an uncapped body query
  // silently yields empty clusters and zero dedup candidates.
  const longBody = "Lead line about a topic. " + "x".repeat(2000);
  const slotsDocs = {
    knowledge: [
      { documentId: "a", name: "a.md", createdAtSec: nowSec - 10, metadata: { atom_type: "decision" }, body: longBody },
      { documentId: "b", name: "b.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: longBody + " tail" },
    ],
  };
  const { deps, calls } = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, mergeResponder: () => ({}), refreshResponder: () => ({}) });
  await consolidateMemory({ now: NOW, llm: false, passes: ["dedupe-by-similarity"], deps });
  assert.ok(calls.searchQueries.length > 0, "ran at least one cluster query");
  for (const q of calls.searchQueries) {
    assert.ok(q.length <= 250, `cluster query length ${q.length} exceeds Dify's 250-char limit`);
  }
});

test("onlyDataset scopes the run to one dataset and bypasses policy", async () => {
  const slotsDocs = {
    knowledge: [{ documentId: "k1", name: "k.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "kbody" }],
    other: [{ documentId: "o1", name: "o.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "obody" }],
  };
  // `other` is an undeclared bound slot that would normally REFUSE; onlyDataset bypasses that.
  const { deps, calls } = makeDeps({
    slotsDocs,
    env: { DIFY_DATASET_KNOWLEDGE_ID: "k", DIFY_DATASET_OTHER_ID: "o" },
    mergeResponder: () => ({}),
    refreshResponder: () => ({}),
  });
  const res = await consolidateMemory({ now: NOW, llm: false, onlyDataset: "knowledge", deps });
  assert.equal(res.ok, true);
  assert.deepEqual(res.refine, ["knowledge"]);
  assert.deepEqual(calls.list, ["knowledge"], "only the scoped dataset was listed");
});

test("slot list-consolidate failure counts as ONE error, not one-per-pass", async () => {
  // Regression (Copilot): incrementing every pass report on a slot-level list
  // failure multiplied totals.errors by the pass count.
  const { deps } = makeDeps({ slotsDocs: { knowledge: [] }, env: KNOWLEDGE_ENV, failList: true, mergeResponder: () => ({}), refreshResponder: () => ({}) });
  const res = await consolidateMemory({ now: NOW, llm: false, deps });
  assert.equal(res.totals.errors, 1, "one slot failure -> one error, not one per pass");
});

test("compress-archived disables the REWRITTEN doc (new upsert id), not the deleted old id", async () => {
  // Regression (Copilot): saveDoc is upsert-by-name -> new id + old deleted, so
  // disabling the old id would fail and leave the truncated doc ENABLED.
  const big = "x".repeat(2000);
  const slotsDocs = {
    knowledge: [
      { documentId: "arch", name: "arch.md", enabled: false, createdAtSec: nowSec - 200 * 86400, metadata: { atom_type: "decision" }, body: big },
    ],
  };
  const { deps, calls } = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, mergeResponder: () => ({}), refreshResponder: () => ({}) });
  const res = await consolidateMemory({ now: NOW, llm: false, passes: ["compress-archived"], deps });
  assert.equal(calls.saveDoc.length, 1, "rewrote the archived doc once");
  const newId = calls.saveDoc[0].id;
  assert.deepEqual(calls.disableDoc, [newId], "disabled the NEW upsert id, keeping it archived");
  assert.notEqual(newId, "arch");
  assert.equal(res.passes["compress-archived"].touched, 1);
});

test("cluster lookup failure is attributed to an ENABLED dedup pass, not always similarity", async () => {
  const slotsDocs = {
    knowledge: [{ documentId: "k1", name: "k.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "b" }],
  };
  const { deps } = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, failSearch: true, mergeResponder: () => ({}), refreshResponder: () => ({}) });
  const res = await consolidateMemory({ now: NOW, llm: false, passes: ["dedupe-by-sha256"], deps });
  assert.equal(res.passes["dedupe-by-sha256"].errors, 1, "error lands on the enabled pass");
  assert.equal(res.passes["dedupe-by-similarity"].errors, 0, "similarity (disabled) not blamed");
});

test("refresh daysSinceRecall is 'never' (not NaN/null) for an unparseable last_recalled_at", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "s", name: "s.md", createdAtSec: nowSec - 9 * MONTH_SEC, metadata: { atom_type: "self-improvement-lesson", last_recalled_at: "not-a-date" }, body: "stale body" },
    ],
  };
  const { deps, calls } = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, mergeResponder: () => ({}), refreshResponder: (o) => ({ action: "keep", leaf_id: o.document.documentId, stale_after: true, reason: "x" }) });
  await consolidateMemory({ now: NOW, passes: ["llm-semantic-refresh"], deps });
  const refreshCall = calls.llm.find((c) => /semantic-refresh/.test(c.systemPrompt));
  assert.ok(refreshCall, "refresh LLM was called");
  const u = JSON.parse(refreshCall.userPrompt);
  assert.equal(u.document.daysSinceRecall, "never");
});

test("provider failure mid-merge falls back to deterministic archive", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "old", name: "dup.md", createdAtSec: nowSec - 100, metadata: { atom_type: "decision" }, body: "same body" },
      { documentId: "new", name: "dup.md", createdAtSec: nowSec, metadata: { atom_type: "decision" }, body: "same body" },
    ],
  };
  const { deps, calls } = makeDeps({ slotsDocs, env: KNOWLEDGE_ENV, failLlm: true, mergeResponder: () => ({}), refreshResponder: () => ({}) });
  const res = await consolidateMemory({ now: NOW, passes: ["dedupe-by-sha256", "llm-merge-near-duplicates"], deps });
  // exact dup still archived deterministically despite LLM being down
  assert.deepEqual(calls.disableDoc, ["old"]);
  assert.equal(res.totals.archived, 1);
});
