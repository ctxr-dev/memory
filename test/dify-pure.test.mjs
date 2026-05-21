// Pure-function tests for mcp-server/src/dify.js — no Dify, no Docker, no
// network. Covers buildDatasetMap (slot inference + legacy fallback),
// buildMetadataCondition (operator selection + null/empty handling), and
// resolveDatasetId / requireDifyWriteConfig (slot name vs UUID heuristic).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDatasetMap,
  buildMetadataCondition,
  canonicalFilterKey,
  resolveDatasetId,
  requireDifyWriteConfig,
  sanitizeHeaderValue,
  getConfig,
  pickDuplicatesToDelete,
  enableDocument,
  disableDocument,
} from "../mcp-server/src/dify.js";
import { withFetchStub } from "./lib/fetch-stub.mjs";

// ---------- buildDatasetMap ----------

test("buildDatasetMap: empty env -> empty map", () => {
  const m = buildDatasetMap({});
  assert.equal(m.size, 0);
});

test("buildDatasetMap: infers slot from DIFY_DATASET_<NAME>_ID", () => {
  const m = buildDatasetMap({
    DIFY_DATASET_DAILY_ID: "uuid-daily",
    DIFY_DATASET_KNOWLEDGE_ID: "uuid-knowledge",
    DIFY_DATASET_SELF_IMPROVEMENT_ID: "uuid-self",
  });
  assert.equal(m.size, 3);
  assert.deepEqual(m.get("daily"), { name: "daily", id: "uuid-daily" });
  assert.deepEqual(m.get("knowledge"), { name: "knowledge", id: "uuid-knowledge" });
  assert.deepEqual(m.get("self_improvement"), { name: "self_improvement", id: "uuid-self" });
});

test("buildDatasetMap: empty value declares an unbound slot", () => {
  const m = buildDatasetMap({ DIFY_DATASET_DAILY_ID: "" });
  assert.equal(m.size, 1);
  assert.deepEqual(m.get("daily"), { name: "daily", id: "" });
});

test("buildDatasetMap: legacy DIFY_WRITE_DATASET_ID becomes 'default' slot when not already mapped", () => {
  const m = buildDatasetMap({ DIFY_WRITE_DATASET_ID: "legacy-uuid" });
  assert.equal(m.size, 1);
  assert.deepEqual(m.get("default"), { name: "default", id: "legacy-uuid" });
});

test("buildDatasetMap: legacy id NOT duplicated when already present in a slot", () => {
  const m = buildDatasetMap({
    DIFY_DATASET_KNOWLEDGE_ID: "shared-uuid",
    DIFY_WRITE_DATASET_ID: "shared-uuid",
  });
  assert.equal(m.size, 1);
  assert.deepEqual(m.get("knowledge"), { name: "knowledge", id: "shared-uuid" });
  assert.equal(m.has("default"), false);
});

test("buildDatasetMap: ignores unrelated env keys", () => {
  const m = buildDatasetMap({
    PATH: "/usr/bin",
    DIFY_API_URL: "http://api:5001/v1",
    SOMETHING_ELSE: "value",
  });
  assert.equal(m.size, 0);
});

// ---------- buildMetadataCondition ----------

test("buildMetadataCondition: null filters -> null", () => {
  assert.equal(buildMetadataCondition(null), null);
  assert.equal(buildMetadataCondition(undefined), null);
  assert.equal(buildMetadataCondition("not-an-object"), null);
});

test("buildMetadataCondition: empty object -> null", () => {
  assert.equal(buildMetadataCondition({}), null);
});

test("buildMetadataCondition: skips null/empty/whitespace values", () => {
  const cond = buildMetadataCondition({
    atom_type: "decision",
    project_module: "",
    language: "  ",
    task_type: null,
    error_pattern: undefined,
  });
  assert.deepEqual(cond, {
    logical_operator: "and",
    conditions: [{ name: "atom_type", comparison_operator: "is", value: "decision" }],
  });
});

test("buildMetadataCondition: tags uses contains, others use is", () => {
  const cond = buildMetadataCondition({
    atom_type: "decision",
    tags: "alpha,beta",
    project_module: "api",
  });
  assert.equal(cond.logical_operator, "and");
  const byName = Object.fromEntries(cond.conditions.map((c) => [c.name, c]));
  assert.equal(byName.atom_type.comparison_operator, "is");
  assert.equal(byName.tags.comparison_operator, "contains");
  assert.equal(byName.project_module.comparison_operator, "is");
});

test("buildMetadataCondition: trims values", () => {
  const cond = buildMetadataCondition({ atom_type: "  decision  " });
  assert.equal(cond.conditions[0].value, "decision");
});

test("buildMetadataCondition: all-empty -> null (not empty conditions list)", () => {
  const cond = buildMetadataCondition({ atom_type: "", tags: "" });
  assert.equal(cond, null);
});

test("buildMetadataCondition: respects logicalOperator override", () => {
  const cond = buildMetadataCondition({ atom_type: "x" }, { logicalOperator: "or" });
  assert.equal(cond.logical_operator, "or");
});

test("buildMetadataCondition: respects containsFields override", () => {
  const cond = buildMetadataCondition(
    { custom: "value" },
    { containsFields: ["custom"] },
  );
  assert.equal(cond.conditions[0].comparison_operator, "contains");
});

// ---------- canonicalFilterKey ----------

test("canonicalFilterKey: equivalent filter sets with different key order hash identically", () => {
  // Locks the recall_lessons ladder dedup contract. V8 preserves insertion
  // order today, so JSON.stringify alone would produce different strings
  // for `{a:1,b:2}` vs `{b:2,a:1}` and the ladder would run the same Dify
  // query twice. canonicalFilterKey sorts keys first.
  const a = { atom_type: "self-improvement-lesson", project_module: "auth", language: "go" };
  const b = { language: "go", project_module: "auth", atom_type: "self-improvement-lesson" };
  assert.equal(canonicalFilterKey(a), canonicalFilterKey(b));
});

test("canonicalFilterKey: different filters hash differently", () => {
  const a = { atom_type: "x" };
  const b = { atom_type: "y" };
  assert.notEqual(canonicalFilterKey(a), canonicalFilterKey(b));
});

test("canonicalFilterKey: null/undefined handled", () => {
  assert.equal(canonicalFilterKey(null), JSON.stringify(null));
  assert.equal(canonicalFilterKey(undefined), JSON.stringify(undefined));
});

test("canonicalFilterKey: empty object is stable", () => {
  assert.equal(canonicalFilterKey({}), "{}");
});

// ---------- resolveDatasetId ----------

test("resolveDatasetId: empty input -> empty string", () => {
  const config = { datasetMap: new Map() };
  assert.equal(resolveDatasetId(config, ""), "");
  assert.equal(resolveDatasetId(config, null), "");
  assert.equal(resolveDatasetId(config, undefined), "");
});

test("resolveDatasetId: known slot name -> mapped id", () => {
  const config = {
    datasetMap: new Map([["knowledge", { name: "knowledge", id: "uuid-knowledge" }]]),
  };
  assert.equal(resolveDatasetId(config, "knowledge"), "uuid-knowledge");
  // case-insensitive
  assert.equal(resolveDatasetId(config, "KNOWLEDGE"), "uuid-knowledge");
  assert.equal(resolveDatasetId(config, "  Knowledge  "), "uuid-knowledge");
});

test("resolveDatasetId: known slot with empty id falls through to UUID heuristic (and fails)", () => {
  const config = {
    datasetMap: new Map([["daily", { name: "daily", id: "" }]]),
  };
  // slot is declared but unbound; not a UUID -> ""
  assert.equal(resolveDatasetId(config, "daily"), "");
});

test("resolveDatasetId: UUID-shaped string passes through", () => {
  const config = { datasetMap: new Map() };
  const uuid = "abcd1234-5678-90ef-abcd-1234567890ef";
  assert.equal(resolveDatasetId(config, uuid), uuid);
  // also pass-through when datasetMap is missing
  assert.equal(resolveDatasetId({}, uuid), uuid);
});

test("resolveDatasetId: short non-UUID returns empty string", () => {
  const config = { datasetMap: new Map() };
  assert.equal(resolveDatasetId(config, "knowledge"), "");
  assert.equal(resolveDatasetId(config, "abc123"), "");
});

// ---------- requireDifyWriteConfig ----------

test("requireDifyWriteConfig: throws when apiKey missing", () => {
  assert.throws(
    () => requireDifyWriteConfig({ apiKey: "", datasetMap: new Map(), datasetIds: [] }),
    /DIFY_KNOWLEDGE_API_KEY/,
  );
});

test("requireDifyWriteConfig: returns resolved id when slot bound", () => {
  const config = {
    apiKey: "secret",
    datasetMap: new Map([["knowledge", { name: "knowledge", id: "uuid-k" }]]),
    datasetIds: ["uuid-k"],
    legacyWriteDatasetId: "",
  };
  assert.equal(requireDifyWriteConfig(config, "knowledge"), "uuid-k");
});

test("requireDifyWriteConfig: throws when slot name unknown / unbound", () => {
  const config = {
    apiKey: "secret",
    datasetMap: new Map([["daily", { name: "daily", id: "" }]]),
    datasetIds: [],
    legacyWriteDatasetId: "",
  };
  assert.throws(
    () => requireDifyWriteConfig(config, "missing"),
    /not configured/,
  );
  // slot exists but unbound -> still rejected
  assert.throws(
    () => requireDifyWriteConfig(config, "daily"),
    /not configured/,
  );
});

test("requireDifyWriteConfig: falls back to legacyWriteDatasetId when no name given", () => {
  const config = {
    apiKey: "secret",
    datasetMap: new Map(),
    datasetIds: [],
    legacyWriteDatasetId: "legacy-uuid",
  };
  assert.equal(requireDifyWriteConfig(config), "legacy-uuid");
});

test("requireDifyWriteConfig: falls back to first datasetIds entry when no legacy id", () => {
  const config = {
    apiKey: "secret",
    datasetMap: new Map([["daily", { name: "daily", id: "uuid-d" }]]),
    datasetIds: ["uuid-d"],
    legacyWriteDatasetId: "",
  };
  assert.equal(requireDifyWriteConfig(config), "uuid-d");
});

test("requireDifyWriteConfig: throws when no fallback available", () => {
  const config = {
    apiKey: "secret",
    datasetMap: new Map(),
    datasetIds: [],
    legacyWriteDatasetId: "",
  };
  assert.throws(
    () => requireDifyWriteConfig(config),
    /No write dataset configured/,
  );
});

test("requireDifyWriteConfig: accepts UUID-shaped explicit id even when not in slot map", () => {
  const config = {
    apiKey: "secret",
    datasetMap: new Map(),
    datasetIds: [],
    legacyWriteDatasetId: "",
  };
  const uuid = "abcd1234-5678-90ef-abcd-1234567890ef";
  assert.equal(requireDifyWriteConfig(config, uuid), uuid);
});

// ---------- sanitizeHeaderValue + getConfig CRLF strip ----------

test("sanitizeHeaderValue: strips CR/LF/whitespace from header-bound values", () => {
  assert.equal(sanitizeHeaderValue("dataset-abc\r\n"), "dataset-abc");
  assert.equal(sanitizeHeaderValue("  bearer-key  "), "bearer-key");
  assert.equal(sanitizeHeaderValue("inline\rinjection"), "inlineinjection");
  assert.equal(sanitizeHeaderValue("inline\ninjection"), "inlineinjection");
  assert.equal(sanitizeHeaderValue(""), "");
  assert.equal(sanitizeHeaderValue(null), "");
  assert.equal(sanitizeHeaderValue(undefined), "");
});

test("getConfig: apiKey + apiUrl arrive sanitised even when env contains CRLF", () => {
  const cfg = getConfig({
    DIFY_KNOWLEDGE_API_KEY: "dataset-secret-pasted-with-newline\r\n",
    DIFY_API_URL: "http://api:5001/v1\r\n",
  });
  assert.equal(cfg.apiKey, "dataset-secret-pasted-with-newline");
  assert.equal(cfg.apiUrl, "http://api:5001/v1");
});

// ---------- pickDuplicatesToDelete (upsertDocumentByName helper) ----------
//
// Locks the round-23 re-list-and-delete-duplicates contract: same-name
// docs are reduced to one on every upsert, with the freshly-created doc
// always preserved. The helper is exported from dify.js purely so this
// test can run without spawning HTTP / Dify.

test("pickDuplicatesToDelete: keeps the new doc, deletes other same-name", () => {
  const docs = [
    { id: "old-1", name: "plan-foo.md" },
    { id: "new-x", name: "plan-foo.md" }, // the freshly-created one
    { id: "old-2", name: "plan-foo.md" },
  ];
  const out = pickDuplicatesToDelete(docs, "plan-foo.md", "new-x");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((d) => d.id).sort(), ["old-1", "old-2"]);
});

test("pickDuplicatesToDelete: skips docs whose name only PARTIALLY matches", () => {
  // Dify's `keyword` filter is substring; the exact-match guard is what
  // stops us from deleting unrelated plan-foo-bar.md when we just wrote
  // plan-foo.md. Regression test for that guard.
  const docs = [
    { id: "old-1", name: "plan-foo.md" },
    { id: "neighbour", name: "plan-foo-bar.md" }, // substring match
    { id: "new-x", name: "plan-foo.md" },
  ];
  const out = pickDuplicatesToDelete(docs, "plan-foo.md", "new-x");
  assert.deepEqual(out.map((d) => d.id), ["old-1"]);
});

test("pickDuplicatesToDelete: no duplicates -> empty list", () => {
  const docs = [{ id: "new-x", name: "plan-foo.md" }];
  assert.deepEqual(pickDuplicatesToDelete(docs, "plan-foo.md", "new-x"), []);
});

test("pickDuplicatesToDelete: skips docs with missing id", () => {
  const docs = [
    { name: "plan-foo.md" }, // missing id
    { id: null, name: "plan-foo.md" },
    { id: "old-1", name: "plan-foo.md" },
    { id: "new-x", name: "plan-foo.md" },
  ];
  const out = pickDuplicatesToDelete(docs, "plan-foo.md", "new-x");
  assert.deepEqual(out.map((d) => d.id), ["old-1"]);
});

test("pickDuplicatesToDelete: non-array input -> empty list (defensive)", () => {
  assert.deepEqual(pickDuplicatesToDelete(null, "x", "y"), []);
  assert.deepEqual(pickDuplicatesToDelete(undefined, "x", "y"), []);
  assert.deepEqual(pickDuplicatesToDelete("not an array", "x", "y"), []);
});

test("pickDuplicatesToDelete: null newDocId -> empty list (NEVER nuke the freshly created doc)", () => {
  // Critical: if the create-by-text response was malformed and the
  // caller passed newDocId === null, the predicate d.id !== null would
  // match EVERY doc, including the one we just created. Bail out so we
  // leave duplicates instead of destroying the new write.
  const docs = [
    { id: "old-1", name: "plan-foo.md" },
    { id: "new-x", name: "plan-foo.md" }, // we DON'T know which one this is
  ];
  assert.deepEqual(pickDuplicatesToDelete(docs, "plan-foo.md", null), []);
  assert.deepEqual(pickDuplicatesToDelete(docs, "plan-foo.md", undefined), []);
});

// ---------- enableDocument / disableDocument (URL + body shape) ----------
//
// Round-26 added enable_document as the symmetric counterpart to
// disable_document. Both PATCH /datasets/<id>/documents/status/<verb>
// with body { document_ids: [id] }. We use the shared withFetchStub
// helper (imported at top) to swap globalThis.fetch for each test.

const STUB_CONFIG = {
  apiKey: "test-key",
  apiUrl: "https://dify.test/v1",
  timeoutMs: 5000,
  datasetMap: new Map([["plans", { id: "ds-uuid-plans" }]]),
};

test("enableDocument: PATCHes /documents/status/enable with document_ids body", async () => {
  await withFetchStub(async (calls) => {
    await enableDocument(STUB_CONFIG, { datasetId: "plans", documentId: "doc-abc" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[0].url, "https://dify.test/v1/datasets/ds-uuid-plans/documents/status/enable");
    assert.deepEqual(JSON.parse(calls[0].body), { document_ids: ["doc-abc"] });
  });
});

test("disableDocument: PATCHes /documents/status/disable with document_ids body", async () => {
  await withFetchStub(async (calls) => {
    await disableDocument(STUB_CONFIG, { datasetId: "plans", documentId: "doc-abc" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[0].url, "https://dify.test/v1/datasets/ds-uuid-plans/documents/status/disable");
    assert.deepEqual(JSON.parse(calls[0].body), { document_ids: ["doc-abc"] });
  });
});

test("enableDocument / disableDocument: symmetric URL pattern (only verb differs)", async () => {
  await withFetchStub(async (calls) => {
    await disableDocument(STUB_CONFIG, { datasetId: "plans", documentId: "doc-z" });
    await enableDocument(STUB_CONFIG, { datasetId: "plans", documentId: "doc-z" });
    assert.equal(calls[0].url.replace("/disable", "/<VERB>"), calls[1].url.replace("/enable", "/<VERB>"));
  });
});

test("enableDocument: missing documentId -> throws", async () => {
  await assert.rejects(
    enableDocument(STUB_CONFIG, { datasetId: "plans" }),
    /enableDocument requires documentId/,
  );
});

// ---------- workspace.js shared constants ----------
//
// Round-33 extracted WORKSPACE_MOUNT + ABSORB_MAX_FILE_BYTES into a
// shared module to eliminate the silent dup between index.js and
// memory-cli.js. Lock the defaults and the env-var override contract.

test("workspace.js: WORKSPACE_MOUNT + ABSORB_MAX_FILE_BYTES export the expected defaults", async () => {
  // Read via dynamic import so any side-effects of module load happen
  // here, and so we can later compare against a re-imported instance
  // with a different env (skipping that for now — module load happens
  // once per node process anyway).
  const ws = await import("../mcp-server/src/workspace.js");
  assert.equal(typeof ws.WORKSPACE_MOUNT, "string");
  assert.ok(ws.WORKSPACE_MOUNT.length > 0, "WORKSPACE_MOUNT must be a non-empty string");
  assert.equal(typeof ws.ABSORB_MAX_FILE_BYTES, "number");
  assert.ok(ws.ABSORB_MAX_FILE_BYTES > 0, "ABSORB_MAX_FILE_BYTES must be a positive number");
  // The default when neither env var is set. In CI / test env neither
  // is set, so we should see the defaults verbatim. If the test runner
  // runs under a non-default env, this still locks "value is sane."
  if (!process.env.WORKSPACE_MOUNT) {
    assert.equal(ws.WORKSPACE_MOUNT, "/workspace");
  }
  if (!process.env.ABSORB_MAX_FILE_BYTES) {
    assert.equal(ws.ABSORB_MAX_FILE_BYTES, 500_000);
  }
});

async function importWorkspaceFresh() {
  return import(`../mcp-server/src/workspace.js?cacheBust=${Date.now()}-${Math.random()}`);
}

test("workspace.js: ABSORB_MAX_FILE_BYTES falls back to default on invalid env values", async () => {
  const prev = process.env.ABSORB_MAX_FILE_BYTES;
  try {
    for (const v of ["-1", "0", "not-a-number"]) {
      process.env.ABSORB_MAX_FILE_BYTES = v;
      const ws = await importWorkspaceFresh();
      assert.equal(ws.ABSORB_MAX_FILE_BYTES, 500_000, `value=${v} should fallback to default`);
    }
  } finally {
    if (prev === undefined) delete process.env.ABSORB_MAX_FILE_BYTES;
    else process.env.ABSORB_MAX_FILE_BYTES = prev;
  }
});

test("workspace.js: ABSORB_MAX_FILE_BYTES honors positive env values", async () => {
  const prev = process.env.ABSORB_MAX_FILE_BYTES;
  try {
    process.env.ABSORB_MAX_FILE_BYTES = "1234";
    const ws = await importWorkspaceFresh();
    assert.equal(ws.ABSORB_MAX_FILE_BYTES, 1234);
  } finally {
    if (prev === undefined) delete process.env.ABSORB_MAX_FILE_BYTES;
    else process.env.ABSORB_MAX_FILE_BYTES = prev;
  }
});

test("workspace.js: inferDefaultProjectModule precedence — explicit override wins", async () => {
  const ws = await importWorkspaceFresh();
  const out = ws.inferDefaultProjectModule({
    MEMORY_DEFAULT_PROJECT_MODULE: "  Auth  ",
    COMPOSE_PROJECT_NAME: "myproject",
  });
  assert.equal(out, "auth");
});

test("workspace.js: inferDefaultProjectModule falls back to COMPOSE_PROJECT_NAME", async () => {
  const ws = await importWorkspaceFresh();
  const out = ws.inferDefaultProjectModule({
    COMPOSE_PROJECT_NAME: "MyProject-Memory",
  });
  assert.equal(out, "myproject-memory");
});

test("workspace.js: inferDefaultProjectModule returns empty string when nothing set", async () => {
  const ws = await importWorkspaceFresh();
  assert.equal(ws.inferDefaultProjectModule({}), "");
});

test("workspace.js: inferDefaultProjectModule rejects unrendered bootstrap placeholder", async () => {
  // If bootstrap.sh is interrupted mid-render, the literal
  // __COMPOSE_PROJECT_NAME__ may persist in memory/.env and forward into
  // the bridge container. We must NOT scope recall to that fake module
  // name — that would silently cross-leak between every broken install.
  const ws = await importWorkspaceFresh();
  assert.equal(ws.inferDefaultProjectModule({ COMPOSE_PROJECT_NAME: "__COMPOSE_PROJECT_NAME__" }), "");
  assert.equal(ws.inferDefaultProjectModule({ COMPOSE_PROJECT_NAME: "__placeholder__" }), "");
  // Sanity: a real value that just HAPPENS to start with an underscore but
  // doesn't have the __...__ shape is preserved.
  assert.equal(ws.inferDefaultProjectModule({ COMPOSE_PROJECT_NAME: "_partial" }), "_partial");
  assert.equal(ws.inferDefaultProjectModule({ COMPOSE_PROJECT_NAME: "my_real_project" }), "my_real_project");
});

test("workspace.js: DEFAULT_PROJECT_MODULE is the resolved snapshot at module load", async () => {
  // DEFAULT_PROJECT_MODULE is computed once at module load (the bridge
  // process reads env at startup; values don't change mid-run). The
  // function inferDefaultProjectModule is what tests should exercise
  // for varying env. The constant must be a string (possibly empty)
  // for callers' simple `value || undefined` injection guard.
  const prevA = process.env.MEMORY_DEFAULT_PROJECT_MODULE;
  const prevB = process.env.COMPOSE_PROJECT_NAME;
  try {
    process.env.MEMORY_DEFAULT_PROJECT_MODULE = "billing";
    delete process.env.COMPOSE_PROJECT_NAME;
    const ws = await importWorkspaceFresh();
    assert.equal(ws.DEFAULT_PROJECT_MODULE, "billing");
  } finally {
    if (prevA === undefined) delete process.env.MEMORY_DEFAULT_PROJECT_MODULE;
    else process.env.MEMORY_DEFAULT_PROJECT_MODULE = prevA;
    if (prevB === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = prevB;
  }
});
