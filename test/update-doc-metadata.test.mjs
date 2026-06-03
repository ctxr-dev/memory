// Lock the updateDocumentMetadata contract: Dify's POST /documents/metadata
// REPLACES a document's entire custom-metadata set, so the helper read-merges by
// default (preserve existing fields, overlay the provided ones) and only skips
// that read when the caller asserts replace:true (it already holds the full set).
// Regression (Copilot): a partial map without read-merge silently wiped unrelated
// metadata (atom_type / project_module / etc.).

import { test } from "node:test";
import assert from "node:assert/strict";

import { updateDocumentMetadata, getDocumentMetadataMap } from "../mcp-server/src/dify.js";
import { withFetchStub } from "./lib/fetch-stub.mjs";

// UUID-shaped id so it survives the internal re-resolution (resolveDatasetId
// accepts a raw UUID-shaped id as-is when it is not a datasetMap key/name).
const DSID = "0123456789abcdef0123456789abcdef";

function cfg() {
  return {
    apiUrl: "https://dify.test/v1",
    apiKey: "dify-test-key",
    datasetMap: new Map([["knowledge", { name: "knowledge", id: DSID }]]),
    datasetIds: [DSID],
    legacyWriteDatasetId: "",
    timeoutMs: 5000,
  };
}

// Field-index GET, dataset-documents list GET, and metadata POST routed by URL.
function difyResponder({ fields, docs }) {
  return (call) => {
    const url = call.url;
    let payload = { result: "success" };
    if (/\/datasets\/[^/]+\/metadata$/.test(url) && (call.method || "GET") === "GET") {
      payload = { doc_metadata: fields };
    } else if (/\/datasets\/[^/]+\/documents\?/.test(url)) {
      payload = { data: docs, has_more: false };
    }
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(payload) };
  };
}

const FIELDS = [
  { id: "f-atom", name: "atom_type", type: "string" },
  { id: "f-mod", name: "project_module", type: "string" },
  { id: "f-stale", name: "stale", type: "string" },
];

function postBody(calls) {
  const post = calls.find((c) => c.method === "POST" && /\/documents\/metadata$/.test(c.url));
  assert.ok(post, "expected a POST to /documents/metadata");
  return JSON.parse(post.body).operation_data[0].metadata_list;
}

test("read-merge (default): existing custom fields are preserved alongside the patch", async () => {
  await withFetchStub(
    async (calls) => {
      await updateDocumentMetadata(cfg(), {
        datasetId: "knowledge",
        documentId: "doc-1",
        metadataMap: { stale: "true" }, // partial patch — only one field
      });
      const list = postBody(calls);
      const byName = Object.fromEntries(list.map((e) => [e.name, e.value]));
      // The patched field is set...
      assert.equal(byName.stale, "true");
      // ...and the previously-existing fields survive (NOT wiped).
      assert.equal(byName.atom_type, "decision");
      assert.equal(byName.project_module, "auth");
      // A list GET happened (the read-merge).
      assert.ok(calls.some((c) => /\/documents\?/.test(c.url)), "read-merge should list the dataset");
    },
    {
      responseFn: difyResponder({
        fields: FIELDS,
        docs: [{ id: "doc-1", doc_metadata: [
          { name: "atom_type", value: "decision" },
          { name: "project_module", value: "auth" },
        ] }],
      }),
    },
  );
});

test("replace:true skips the read-merge and posts ONLY the provided fields", async () => {
  await withFetchStub(
    async (calls) => {
      await updateDocumentMetadata(cfg(), {
        datasetId: "knowledge",
        documentId: "doc-1",
        metadataMap: { atom_type: "decision", project_module: "auth", stale: "false" },
        replace: true,
      });
      const list = postBody(calls);
      const names = list.map((e) => e.name).sort();
      assert.deepEqual(names, ["atom_type", "project_module", "stale"]);
      // No document-list read when the caller asserts the full set.
      assert.ok(!calls.some((c) => /\/documents\?/.test(c.url)), "replace:true must NOT read the dataset");
    },
    { responseFn: difyResponder({ fields: FIELDS, docs: [] }) },
  );
});

test("getDocumentMetadataMap: flattens a doc's doc_metadata; {} when not found", async () => {
  await withFetchStub(
    async () => {
      const map = await getDocumentMetadataMap(cfg(), { datasetId: "knowledge", documentId: "doc-1" });
      assert.deepEqual(map, { atom_type: "decision", stale: "true" });
      const missing = await getDocumentMetadataMap(cfg(), { datasetId: "knowledge", documentId: "nope" });
      assert.deepEqual(missing, {});
    },
    {
      responseFn: difyResponder({
        fields: FIELDS,
        docs: [{ id: "doc-1", doc_metadata: [
          { name: "atom_type", value: "decision" },
          { name: "stale", value: "true" },
        ] }],
      }),
    },
  );
});
