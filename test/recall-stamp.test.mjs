// Lock the recall-stamp helper: the debounce predicate, the write-amplification
// controls (one field-index GET + one list GET per dataset), the
// metadata-PRESERVING merge (Dify's POST replaces the full set, so existing
// custom fields must be carried), the missing-field no-op, and swallowed errors.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFetchStub } from "./lib/fetch-stub.mjs";
import { shouldStamp, stampRecalls, _resetStampCache } from "../mcp-server/src/recall-stamp.js";

const DATASET = "00000000-0000-0000-0000-000000000abc"; // UUID-shaped so resolveDatasetId accepts it
const CONFIG = { apiKey: "k", apiUrl: "http://api:5001/v1", timeoutMs: 5000, datasetMap: new Map(), datasetIds: [] };
const HOUR = 60 * 60 * 1000;

// Field definitions (the dataset's custom metadata fields). atom_type is present
// so it must be preserved across a recall stamp.
const FIELDS = [
  { id: "f-atom", name: "atom_type", type: "string" },
  { id: "f-recalled", name: "last_recalled_at", type: "string" },
  { id: "f-count", name: "recall_count", type: "string" },
];

// Route stub responses by URL: POST documents/metadata vs GET documents (list)
// vs GET metadata (field index).
function responder({ fields = FIELDS, docs = [], postOk = true } = {}) {
  return (call) => {
    if (call.url.includes("/documents/metadata")) {
      return { ok: postOk, status: postOk ? 200 : 500, statusText: postOk ? "OK" : "ERR", text: async () => '{"result":"success"}' };
    }
    if (call.url.includes("/documents")) {
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ data: docs, has_more: false }) };
    }
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ doc_metadata: fields }) };
  };
}

const DOCS = [
  { id: "d1", doc_metadata: [{ name: "atom_type", value: "bug-root-cause" }, { name: "document_name", value: "d1.md" }] },
  { id: "d2", doc_metadata: [{ name: "atom_type", value: "feedback-rule" }] },
];

test("shouldStamp: absent/within-window/older/boundary", () => {
  const now = 1_000 * HOUR;
  assert.equal(shouldStamp(null, now, 24), true);
  assert.equal(shouldStamp("not-a-date", now, 24), true);
  assert.equal(shouldStamp(new Date(now - 1 * HOUR).toISOString(), now, 24), false);
  assert.equal(shouldStamp(new Date(now - 25 * HOUR).toISOString(), now, 24), true);
  assert.equal(shouldStamp(new Date(now - 24 * HOUR).toISOString(), now, 24), true);
});

test("stampRecalls: one field GET + one list GET per dataset; multi-chunk docs collapse; existing fields preserved", () => {
  _resetStampCache();
  return withFetchStub(async (calls) => {
    const records = [
      { documentId: "d1", datasetId: DATASET },
      { documentId: "d1", datasetId: DATASET }, // duplicate chunk
      { documentId: "d2", datasetId: DATASET },
    ];
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records, nowMs: 1_000 * HOUR, debounceHours: 24 });
    const fieldGets = calls.filter((c) => c.url.endsWith("/metadata") && !c.url.includes("/documents"));
    const listGets = calls.filter((c) => /\/documents\?/.test(c.url));
    const posts = calls.filter((c) => c.url.includes("/documents/metadata"));
    assert.equal(fieldGets.length, 1, "one field-index GET");
    assert.equal(listGets.length, 1, "one list GET (to read current metadata)");
    assert.equal(posts.length, 2, "one POST per unique documentId");
    assert.equal(summary.stamped, 2);
    // d1's POST preserves atom_type AND sets last_recalled_at + recall_count, and
    // does NOT echo the Dify built-in document_name.
    const d1 = posts.find((p) => JSON.parse(p.body).operation_data[0].document_id === "d1");
    const list = JSON.parse(d1.body).operation_data[0].metadata_list;
    const byName = Object.fromEntries(list.map((m) => [m.name, m.value]));
    assert.equal(byName.atom_type, "bug-root-cause", "existing atom_type preserved");
    assert.ok(byName.last_recalled_at, "last_recalled_at set");
    assert.equal(byName.recall_count, "1");
    assert.equal("document_name" in byName, false, "built-in not echoed");
  }, { responseFn: responder({ docs: DOCS }) });
});

test("stampRecalls: recall_count seeds from the PERSISTED value on a cold cache", () => {
  _resetStampCache();
  const docs = [{ id: "d1", doc_metadata: [{ name: "atom_type", value: "bug-root-cause" }, { name: "recall_count", value: "5" }] }];
  return withFetchStub(async (calls) => {
    await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR });
    const post = calls.find((c) => c.url.includes("/documents/metadata"));
    const list = JSON.parse(post.body).operation_data[0].metadata_list;
    assert.equal(list.find((m) => m.name === "recall_count").value, "6", "seeded from persisted 5 -> 6, not reset to 1");
  }, { responseFn: responder({ docs }) });
});

test("stampRecalls: reads fresh metadata each run (no stale cross-call cache that could roll back fields)", () => {
  _resetStampCache();
  const docs = [
    { id: "d1", doc_metadata: [{ name: "atom_type", value: "x" }] },
    { id: "d2", doc_metadata: [{ name: "atom_type", value: "y" }] },
  ];
  return withFetchStub(async (calls) => {
    await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1000 });
    await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d2", datasetId: DATASET }], nowMs: 1000 + 5000 });
    const lists = calls.filter((c) => /\/documents\?/.test(c.url));
    assert.equal(lists.length, 2, "each run re-lists fresh (no stale snapshot reuse)");
  }, { responseFn: responder({ docs }) });
});

test("stampRecalls: dataset missing last_recalled_at field -> zero POSTs and no list GET", () => {
  _resetStampCache();
  return withFetchStub(async (calls) => {
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR });
    assert.equal(calls.filter((c) => c.url.includes("/documents/metadata")).length, 0);
    assert.equal(calls.filter((c) => /\/documents\?/.test(c.url)).length, 0, "no list GET when field absent");
    assert.equal(summary.stamped, 0);
  }, { responseFn: responder({ fields: [{ id: "f-atom", name: "atom_type" }] }) });
});

test("stampRecalls: list (metadata read) failure SKIPS stamping (never risks a wipe)", () => {
  _resetStampCache();
  return withFetchStub(async (calls) => {
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR });
    assert.equal(calls.filter((c) => c.url.includes("/documents/metadata")).length, 0, "no POST when current metadata can't be read");
    assert.equal(summary.stamped, 0);
  }, { responseFn: (call) => {
    if (/\/documents\?/.test(call.url)) return { ok: false, status: 500, statusText: "ERR", text: async () => "{}" };
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ doc_metadata: FIELDS }) };
  } });
});

test("stampRecalls: a recalled doc ABSENT from the listing is skipped (never a partial wipe)", () => {
  // Regression (Copilot): metaById.get(missingId) was {} (same as a doc with no
  // custom fields), so an indexing-lagged doc would be stamped with ONLY the
  // recall fields, wiping atom_type/project_module (Dify replaces the full set).
  _resetStampCache();
  const docs = [{ id: "present", doc_metadata: [{ name: "atom_type", value: "bug-root-cause" }] }];
  return withFetchStub(async (calls) => {
    const summary = await stampRecalls(CONFIG, {
      datasetId: DATASET,
      records: [{ documentId: "ghost", datasetId: DATASET }], // not in the snapshot
      nowMs: 1_000 * HOUR,
      debounceHours: 24,
    });
    assert.equal(calls.filter((c) => c.url.includes("/documents/metadata")).length, 0, "no POST for a doc absent from the listing");
    assert.equal(summary.stamped, 0);
    assert.equal(summary.skipped, 1);
  }, { responseFn: responder({ docs }) });
});

test("stampRecalls: persisted last_recalled_at debounces a cold cache (no re-stamp after restart)", () => {
  _resetStampCache(); // simulate a fresh process (cold cache)
  const recentIso = new Date(1_000 * HOUR - 1 * HOUR).toISOString(); // stamped 1h ago, within the 24h window
  const docs = [{ id: "d1", doc_metadata: [{ name: "atom_type", value: "bug-root-cause" }, { name: "last_recalled_at", value: recentIso }] }];
  return withFetchStub(async (calls) => {
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR, debounceHours: 24 });
    assert.equal(calls.filter((c) => c.url.includes("/documents/metadata")).length, 0, "persisted-recent doc not re-stamped on a cold cache");
    assert.equal(summary.skipped, 1);
  }, { responseFn: responder({ docs }) });
});

test("stampRecalls: per-doc POST failure is swallowed (resolves, errors counted)", () => {
  _resetStampCache();
  return withFetchStub(async () => {
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR });
    assert.equal(summary.stamped, 0);
    assert.ok(summary.errors >= 1);
  }, { responseFn: responder({ docs: DOCS, postOk: false }) });
});

test("stampRecalls: debounce skips a re-stamp inside the window; bumps recall_count after it", async () => {
  _resetStampCache();
  await withFetchStub(async (calls) => {
    await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR, debounceHours: 24 });
    assert.equal(calls.filter((c) => c.url.includes("/documents/metadata")).length, 1);
  }, { responseFn: responder({ docs: DOCS }) });

  await withFetchStub(async (calls) => {
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR + HOUR, debounceHours: 24 });
    assert.equal(calls.length, 0, "fully debounced: no calls at all");
    assert.equal(summary.skipped, 1);
  }, { responseFn: responder({ docs: DOCS }) });

  await withFetchStub(async (calls) => {
    await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR + 25 * HOUR, debounceHours: 24 });
    const posts = calls.filter((c) => c.url.includes("/documents/metadata"));
    assert.equal(posts.length, 1);
    const list = JSON.parse(posts[0].body).operation_data[0].metadata_list;
    assert.equal(list.find((m) => m.name === "recall_count").value, "2");
  }, { responseFn: responder({ docs: DOCS }) });
});
