// Tests for the shared test helpers in test/lib/. These helpers are
// load-bearing (multiple test files import them); a regression here
// would cascade silently into "tests pass for the wrong reason."

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withFetchStub } from "./lib/fetch-stub.mjs";
import { runCli } from "./lib/run-cli.mjs";

test("withFetchStub: captures URL + method + body of every fetch call", async () => {
  await withFetchStub(async (calls) => {
    await globalThis.fetch("https://example.test/a", { method: "POST", body: "hello" });
    await globalThis.fetch("https://example.test/b", { method: "PATCH", body: "world" });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://example.test/a");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, "hello");
    assert.equal(calls[1].url, "https://example.test/b");
    assert.equal(calls[1].method, "PATCH");
  });
});

test("withFetchStub: restores globalThis.fetch even when the body throws", async () => {
  const beforeFetch = globalThis.fetch;
  await assert.rejects(
    withFetchStub(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(globalThis.fetch, beforeFetch, "fetch must be restored after a thrown body");
});

test("withFetchStub: restores globalThis.fetch after a normal return", async () => {
  const beforeFetch = globalThis.fetch;
  const result = await withFetchStub(async () => 42);
  assert.equal(result, 42);
  assert.equal(globalThis.fetch, beforeFetch);
});

// runCli helper: spawn a tiny .mjs that dumps the env vars we care
// about, then assert the strip + override semantics.
async function runEnvChecker(envOverrides) {
  const checker =
    "console.log(JSON.stringify({" +
    "  hookDisable: process.env.MEMORY_HOOK_EXITPLANMODE_DISABLE ?? null," +
    "  plansId: process.env.DIFY_DATASET_PLANS_ID ?? null," +
    "  container: process.env.MCP_CONTAINER_NAME ?? null," +
    "  override: process.env.MY_TEST_OVERRIDE_VAR ?? null," +
    "}));";
  const tmpPath = path.join(os.tmpdir(), `run-cli-helper-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmpPath, checker);
  try {
    const r = runCli(tmpPath, "", envOverrides);
    if (r.status !== 0) {
      throw new Error(`node exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

test("runCli: strips MEMORY_HOOK_* / DIFY_DATASET_* / MCP_CONTAINER_NAME from inherited env", async (t) => {
  // Plant sentinel values in our env so we would see them leak if
  // the strip failed. t.after restores even on failure.
  const prevHook = process.env.MEMORY_HOOK_EXITPLANMODE_DISABLE;
  const prevPlans = process.env.DIFY_DATASET_PLANS_ID;
  const prevContainer = process.env.MCP_CONTAINER_NAME;
  process.env.MEMORY_HOOK_EXITPLANMODE_DISABLE = "SENTINEL_HOOK";
  process.env.DIFY_DATASET_PLANS_ID = "SENTINEL_PLANS";
  process.env.MCP_CONTAINER_NAME = "SENTINEL_CONTAINER";
  t.after(() => {
    if (prevHook === undefined) delete process.env.MEMORY_HOOK_EXITPLANMODE_DISABLE;
    else process.env.MEMORY_HOOK_EXITPLANMODE_DISABLE = prevHook;
    if (prevPlans === undefined) delete process.env.DIFY_DATASET_PLANS_ID;
    else process.env.DIFY_DATASET_PLANS_ID = prevPlans;
    if (prevContainer === undefined) delete process.env.MCP_CONTAINER_NAME;
    else process.env.MCP_CONTAINER_NAME = prevContainer;
  });

  const result = await runEnvChecker({});
  assert.equal(result.hookDisable, null, "MEMORY_HOOK_EXITPLANMODE_DISABLE should be stripped");
  assert.equal(result.plansId, null, "DIFY_DATASET_PLANS_ID should be stripped");
  assert.equal(result.container, null, "MCP_CONTAINER_NAME should be stripped");
});

test("runCli: envOverrides layered on top of stripped env", async () => {
  const result = await runEnvChecker({
    DIFY_DATASET_PLANS_ID: "test-uuid",
    MY_TEST_OVERRIDE_VAR: "yes",
  });
  assert.equal(result.plansId, "test-uuid");
  assert.equal(result.override, "yes");
});
