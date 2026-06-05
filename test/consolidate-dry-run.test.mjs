// Lock the consolidate result JSON shape and the dry-run "zero writes" contract.
// (Engine behaviour is covered in consolidate-engine.test.mjs; this pins the
// result envelope the cron + the gated live dry-run report depend on.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { consolidateMemory, ALL_PASS_NAMES } from "../scripts/consolidate.mjs";

const NOW = new Date("2026-06-03T00:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

function makeDeps(slotsDocs, env) {
  const calls = { saveDoc: [], disableDoc: [], updateMeta: [] };
  let state = null;
  return {
    calls,
    deps: {
      loadEnv: () => env,
      acquireLock: () => ({ ok: true, release() {} }),
      readState: () => state,
      writeState: (s) => { state = s; },
      listForConsolidate: async ({ datasetId }) => ({
        documents: (slotsDocs[datasetId] || []).map((d) => ({ documentId: d.documentId, name: d.name, enabled: true, createdAt: d.createdAtSec ?? nowSec, metadata: d.metadata || {} })),
      }),
      readBody: async ({ documentId }) => (Object.values(slotsDocs).flat().find((d) => d.documentId === documentId)?.body ?? ""),
      searchSimilar: async ({ datasetId, query }) => {
        const docs = slotsDocs[datasetId] || [];
        const self = docs.find((d) => String(d.body).slice(0, 1024) === query);
        return { records: docs.filter((d) => d !== self).map((d) => ({ documentId: d.documentId, score: 0.99, content: d.body })) };
      },
      saveDoc: async (a) => { calls.saveDoc.push(a); return { id: "x" }; },
      disableDoc: async (a) => { calls.disableDoc.push(a); },
      updateMeta: async (a) => { calls.updateMeta.push(a); },
      llm: async () => ({}),
    },
  };
}

test("dry-run result envelope has the locked keys and per-pass reports", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "a", name: "a.md", metadata: { atom_type: "decision" }, body: "same" },
      { documentId: "b", name: "b.md", metadata: { atom_type: "decision" }, body: "same" },
    ],
  };
  const { deps } = makeDeps(slotsDocs, { DIFY_DATASET_KNOWLEDGE_ID: "k" });
  const res = await consolidateMemory({ now: NOW, dryRun: true, llm: false, deps });

  for (const key of ["ok", "dryRun", "llm", "llmRequested", "policies", "refine", "workingSetSize", "passes", "totals"]) {
    assert.ok(key in res, `result missing key '${key}'`);
  }
  assert.equal(res.dryRun, true);
  assert.deepEqual(res.refine, ["knowledge"]);
  // Every pass present with the canonical counters.
  for (const name of ALL_PASS_NAMES) {
    assert.ok(res.passes[name], `missing pass report '${name}'`);
    for (const k of ["archived", "merged", "refreshed", "flagged", "touched", "errors", "freedBytes"]) {
      assert.equal(typeof res.passes[name][k], "number");
    }
  }
  for (const k of ["archived", "merged", "refreshed", "flagged", "touched", "errors", "freedBytes"]) {
    assert.equal(typeof res.totals[k], "number");
  }
});

test("dry-run performs zero writes and writes no state file", async () => {
  const slotsDocs = {
    knowledge: [
      { documentId: "a", name: "a.md", metadata: { atom_type: "decision" }, body: "same" },
      { documentId: "b", name: "b.md", metadata: { atom_type: "decision" }, body: "same" },
    ],
  };
  const { deps, calls } = makeDeps(slotsDocs, { DIFY_DATASET_KNOWLEDGE_ID: "k" });
  let stateWritten = false;
  const wrapped = { ...deps, writeState: () => { stateWritten = true; } };
  const res = await consolidateMemory({ now: NOW, dryRun: true, llm: false, deps: wrapped });
  assert.equal(calls.saveDoc.length, 0);
  assert.equal(calls.disableDoc.length, 0);
  assert.equal(calls.updateMeta.length, 0);
  assert.equal(stateWritten, false, "dry-run must not write the state file");
  // projection still reflects the exact-dup as archivable (counted) under dry-run
  assert.equal(res.totals.archived, 1);
});
