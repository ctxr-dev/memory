// Lock the fire-and-forget contract: the dispatch NEVER rejects, even when the
// underlying stamping throws, and it groups records by dataset. This is the
// invariant that keeps a metadata-write failure from ever breaking a read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withFetchStub } from "./lib/fetch-stub.mjs";
import { stampRecallsFireAndForget, _resetStampCache } from "../mcp-server/src/recall-stamp.js";

const DS_A = "00000000-0000-0000-0000-00000000aaaa";
const DS_B = "00000000-0000-0000-0000-00000000bbbb";
const CONFIG = { apiKey: "k", apiUrl: "http://api:5001/v1", timeoutMs: 5000, datasetMap: new Map(), datasetIds: [] };

test("stampRecallsFireAndForget: resolves (never rejects) even when every fetch throws", async () => {
  _resetStampCache();
  await withFetchStub(async () => {
    const records = [
      { documentId: "d1", datasetId: DS_A },
      { documentId: "d2", datasetId: DS_B },
    ];
    // The helper returns a promise; it must resolve, not reject, despite the
    // field-index GET throwing for every dataset.
    await assert.doesNotReject(stampRecallsFireAndForget(CONFIG, records, 1000));
  }, { responseFn: () => ({ ok: false, status: 500, statusText: "ERR", text: async () => "{}" }) });
});

test("stampRecallsFireAndForget: ignores records without documentId or datasetId", async () => {
  _resetStampCache();
  await withFetchStub(async (calls) => {
    const records = [
      { documentId: "d1" }, // no datasetId
      { datasetId: DS_A }, // no documentId
      null,
    ];
    await stampRecallsFireAndForget(CONFIG, records, 1000);
    assert.equal(calls.length, 0, "no fetches for unusable records");
  }, { responseFn: () => ({ ok: true, status: 200, statusText: "OK", text: async () => '{"doc_metadata":[]}' }) });
});

test("stampRecallsFireAndForget: groups by dataset (one field-index GET per dataset)", async () => {
  _resetStampCache();
  await withFetchStub(async (calls) => {
    const records = [
      { documentId: "d1", datasetId: DS_A },
      { documentId: "d2", datasetId: DS_A },
      { documentId: "d3", datasetId: DS_B },
    ];
    await stampRecallsFireAndForget(CONFIG, records, 1000);
    // one field-index GET per distinct dataset (A, B); the list GET ends in
    // /documents?... and the POST in /documents/metadata, so exclude both.
    const fieldGets = calls.filter((c) => c.url.endsWith("/metadata") && !c.url.includes("/documents"));
    assert.equal(fieldGets.length, 2);
  }, { responseFn: (call) => {
    if (call.url.includes("/documents/metadata")) return { ok: true, status: 200, statusText: "OK", text: async () => '{"result":"ok"}' };
    if (/\/documents\?/.test(call.url)) return { ok: true, status: 200, statusText: "OK", text: async () => '{"data":[],"has_more":false}' };
    return { ok: true, status: 200, statusText: "OK", text: async () => '{"doc_metadata":[{"id":"f","name":"last_recalled_at","type":"string"}]}' };
  } });
});
