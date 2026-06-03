// Lock the recall-stamp helper: the debounce predicate, the one-field-GET +
// multi-chunk-collapse write-amplification controls, the missing-field no-op,
// and the swallowed per-doc failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFetchStub } from "./lib/fetch-stub.mjs";
import { shouldStamp, stampRecalls, _resetStampCache } from "../mcp-server/src/recall-stamp.js";

const DATASET = "00000000-0000-0000-0000-000000000abc"; // UUID-shaped so resolveDatasetId accepts it
const CONFIG = { apiKey: "k", apiUrl: "http://api:5001/v1", timeoutMs: 5000, datasetMap: new Map(), datasetIds: [] };
const HOUR = 60 * 60 * 1000;

// Field-index GET response with the consolidate/recall fields present.
function fieldIndexBody(fields) {
  return JSON.stringify({ doc_metadata: fields });
}
// Branch responses by URL: the documents/metadata POST vs the dataset /metadata GET.
function responder({ fields, postOk = true }) {
  return (call) => {
    if (call.url.includes("/documents/metadata")) {
      return { ok: postOk, status: postOk ? 200 : 500, statusText: postOk ? "OK" : "ERR", text: async () => '{"result":"success"}' };
    }
    return { ok: true, status: 200, statusText: "OK", text: async () => fieldIndexBody(fields) };
  };
}

const WITH_FIELDS = [
  { id: "f-recalled", name: "last_recalled_at", type: "string" },
  { id: "f-count", name: "recall_count", type: "string" },
];

test("shouldStamp: absent/within-window/older/boundary", () => {
  const now = 1_000 * HOUR;
  assert.equal(shouldStamp(null, now, 24), true); // never stamped
  assert.equal(shouldStamp("not-a-date", now, 24), true); // unparseable
  assert.equal(shouldStamp(new Date(now - 1 * HOUR).toISOString(), now, 24), false); // within window
  assert.equal(shouldStamp(new Date(now - 25 * HOUR).toISOString(), now, 24), true); // older
  assert.equal(shouldStamp(new Date(now - 24 * HOUR).toISOString(), now, 24), true); // exactly at window
});

test("stampRecalls: one field GET per dataset; multi-chunk docs collapse to one POST each", async () => {
  _resetStampCache();
  await withFetchStub(async (calls) => {
    const records = [
      { documentId: "d1", datasetId: DATASET },
      { documentId: "d1", datasetId: DATASET }, // duplicate chunk of same doc
      { documentId: "d2", datasetId: DATASET },
    ];
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records, nowMs: 1_000 * HOUR, debounceHours: 24 });
    const gets = calls.filter((c) => !c.url.includes("/documents/metadata"));
    const posts = calls.filter((c) => c.url.includes("/documents/metadata"));
    assert.equal(gets.length, 1, "exactly one field-index GET");
    assert.equal(posts.length, 2, "one POST per unique documentId");
    assert.equal(summary.stamped, 2);
    // POST body carries last_recalled_at + recall_count=1
    const body = JSON.parse(posts[0].body);
    const list = body.operation_data[0].metadata_list;
    const names = list.map((m) => m.name).sort();
    assert.deepEqual(names, ["last_recalled_at", "recall_count"]);
    assert.equal(list.find((m) => m.name === "recall_count").value, "1");
  }, { responseFn: responder({ fields: WITH_FIELDS }) });
});

test("stampRecalls: dataset missing last_recalled_at field -> zero POSTs (graceful no-op)", async () => {
  _resetStampCache();
  await withFetchStub(async (calls) => {
    const records = [{ documentId: "d1", datasetId: DATASET }];
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records, nowMs: 1_000 * HOUR });
    const posts = calls.filter((c) => c.url.includes("/documents/metadata"));
    assert.equal(posts.length, 0);
    assert.equal(summary.stamped, 0);
  }, { responseFn: responder({ fields: [{ id: "f-atom", name: "atom_type", type: "string" }] }) });
});

test("stampRecalls: per-doc POST failure is swallowed (resolves, errors counted)", async () => {
  _resetStampCache();
  await withFetchStub(async () => {
    const records = [{ documentId: "d1", datasetId: DATASET }];
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records, nowMs: 1_000 * HOUR });
    assert.equal(summary.stamped, 0);
    assert.ok(summary.errors >= 1);
  }, { responseFn: responder({ fields: WITH_FIELDS, postOk: false }) });
});

test("stampRecalls: debounce skips a re-stamp inside the window; bumps recall_count after it", async () => {
  _resetStampCache();
  // First stamp at t0.
  await withFetchStub(async (calls) => {
    await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR, debounceHours: 24 });
    assert.equal(calls.filter((c) => c.url.includes("/documents/metadata")).length, 1);
  }, { responseFn: responder({ fields: WITH_FIELDS }) });

  // Immediate second call (same hour) -> debounced, no POST.
  await withFetchStub(async (calls) => {
    const summary = await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR + HOUR, debounceHours: 24 });
    assert.equal(calls.filter((c) => c.url.includes("/documents/metadata")).length, 0);
    assert.equal(summary.skipped, 1);
  }, { responseFn: responder({ fields: WITH_FIELDS }) });

  // After the window, re-stamps and bumps recall_count to 2.
  await withFetchStub(async (calls) => {
    await stampRecalls(CONFIG, { datasetId: DATASET, records: [{ documentId: "d1", datasetId: DATASET }], nowMs: 1_000 * HOUR + 25 * HOUR, debounceHours: 24 });
    const posts = calls.filter((c) => c.url.includes("/documents/metadata"));
    assert.equal(posts.length, 1);
    const list = JSON.parse(posts[0].body).operation_data[0].metadata_list;
    assert.equal(list.find((m) => m.name === "recall_count").value, "2");
  }, { responseFn: responder({ fields: WITH_FIELDS }) });
});
