// Lock the embedding-model resolution contract (v0.3.1). The bridge must NOT
// guess/force a tenant embedding model. On create it omits the embedding so
// Dify applies the tenant System Default; on retrieve it echoes back the
// DATASET'S OWN embedding model (read from GET /datasets/{id}), which is what
// Dify's hybrid_search validator requires and is always correct even on a
// tenant with multiple embedding providers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDataset, retrieveChunks, datasetMetaFor } from "../mcp-server/src/dify.js";
import { withFetchStub } from "./lib/fetch-stub.mjs";

const config = { apiUrl: "http://api:5001/v1", apiKey: "test-key", timeoutMs: 5000 };

function jsonResponse(obj) {
  return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(obj) };
}

test("createDataset (no explicit embedding) omits embedding_model AND retrieval_model so Dify applies the System Default", async () => {
  await withFetchStub(async (calls) => {
    await createDataset(config, { name: "knowledge" });
    const body = JSON.parse(calls[0].body);
    assert.equal(body.name, "knowledge");
    assert.equal(body.indexing_technique, "high_quality");
    assert.ok(!("embedding_model" in body), "must not send embedding_model");
    assert.ok(!("embedding_model_provider" in body), "must not send embedding_model_provider");
    assert.ok(!("retrieval_model" in body), "must not send a retrieval_model (it would 400 without embedding fields)");
  }, { responseFn: () => jsonResponse({ id: "ds-new" }) });
});

test("createDataset (explicit pin) sends both top-level + nested vector_setting embedding fields", async () => {
  await withFetchStub(async (calls) => {
    await createDataset(config, {
      name: "pinned",
      embeddingModel: "text-embedding-3-large",
      embeddingModelProvider: "langgenius/openai/openai",
    });
    const body = JSON.parse(calls[0].body);
    assert.equal(body.embedding_model, "text-embedding-3-large");
    assert.equal(body.embedding_model_provider, "langgenius/openai/openai");
    const vs = body.retrieval_model.weights.vector_setting;
    assert.equal(vs.embedding_provider_name, "langgenius/openai/openai");
    assert.equal(vs.embedding_model_name, "text-embedding-3-large");
  }, { responseFn: () => jsonResponse({ id: "ds-pinned" }) });
});

test("createDataset rejects half-specified embedding args", async () => {
  await assert.rejects(
    () => createDataset(config, { name: "x", embeddingModel: "m" }),
    /BOTH embeddingModel and embeddingModelProvider, or neither/,
  );
});

test("retrieveChunks echoes the DATASET'S OWN embedding into the hybrid_search vector_setting", async () => {
  await withFetchStub(async (calls) => {
    await retrieveChunks(config, { datasetId: "ds-hq-1", query: "hello", scoreThreshold: 0.5 });
    // First call resolves dataset meta; second is the retrieve.
    const get = calls.find((c) => c.method !== "POST" && c.url.endsWith("/datasets/ds-hq-1"));
    const post = calls.find((c) => c.url.endsWith("/datasets/ds-hq-1/retrieve"));
    assert.ok(get, "must GET the dataset to read its embedding model");
    assert.ok(post, "must POST to retrieve");
    const vs = JSON.parse(post.body).retrieval_model.weights.vector_setting;
    assert.equal(vs.embedding_provider_name, "langgenius/openai/openai");
    assert.equal(vs.embedding_model_name, "text-embedding-3-large");
  }, {
    responseFn: (call) => {
      if (call.url.endsWith("/datasets/ds-hq-1") && call.method !== "POST") {
        return jsonResponse({
          indexing_technique: "high_quality",
          embedding_model: "text-embedding-3-large",
          embedding_model_provider: "langgenius/openai/openai",
        });
      }
      return jsonResponse({ records: [] });
    },
  });
});

test("retrieveChunks throws for a high_quality dataset with no resolvable embedding model", async () => {
  await withFetchStub(async () => {
    await assert.rejects(
      () => retrieveChunks(config, { datasetId: "ds-hq-noembed", query: "hi", scoreThreshold: 0.5 }),
      /embedding model could not be resolved/,
    );
  }, {
    responseFn: (call) => {
      if (call.url.endsWith("/datasets/ds-hq-noembed") && call.method !== "POST") {
        return jsonResponse({ indexing_technique: "high_quality" }); // no embedding_model
      }
      return jsonResponse({ records: [] });
    },
  });
});

test("retrieveChunks on an economy dataset uses keyword_search (no embedding required)", async () => {
  await withFetchStub(async (calls) => {
    await retrieveChunks(config, { datasetId: "ds-econ-1", query: "hello", scoreThreshold: 0.5 });
    const post = calls.find((c) => c.url.endsWith("/datasets/ds-econ-1/retrieve"));
    const rm = JSON.parse(post.body).retrieval_model;
    assert.equal(rm.search_method, "keyword_search");
    assert.ok(!rm.weights, "keyword_search has no vector_setting weights");
  }, {
    responseFn: (call) => {
      if (call.url.endsWith("/datasets/ds-econ-1") && call.method !== "POST") {
        return jsonResponse({ indexing_technique: "economy" });
      }
      return jsonResponse({ records: [] });
    },
  });
});

test("datasetMetaFor caches: one GET per dataset id across repeated calls", async () => {
  await withFetchStub(async (calls) => {
    const a = await datasetMetaFor(config, "ds-cache-unique-1");
    const b = await datasetMetaFor(config, "ds-cache-unique-1");
    assert.equal(a.embeddingModel, "text-embedding-3-large");
    assert.equal(b.embeddingModel, "text-embedding-3-large");
    const gets = calls.filter((c) => c.url.endsWith("/datasets/ds-cache-unique-1"));
    assert.equal(gets.length, 1, "second call must hit the cache, not re-GET");
  }, {
    responseFn: () => jsonResponse({
      indexing_technique: "high_quality",
      embedding_model: "text-embedding-3-large",
      embedding_model_provider: "langgenius/openai/openai",
    }),
  });
});
