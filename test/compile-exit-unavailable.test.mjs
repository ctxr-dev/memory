// Lock compile's exit-code contract: when a daily-promotion run cannot reach the
// Dify bridge / LLM provider, compile must exit 69 (EX_UNAVAILABLE), NOT 0.
// Exit 0 looked clean and let the hourly cron record a silently-skipped tick as
// healthy (the 2026-06-04 upstream incident). Driven as a real subprocess with a
// bogus MCP container so the FIRST bridge call (listDocuments) throws
// DifyBridgeUnavailable; portable to CI (no docker -> spawn ENOENT -> the same
// DifyBridgeUnavailable -> 69).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPILE_CLI = fileURLToPath(new URL("../scripts/compile.mjs", import.meta.url));

function runCompile(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-exit-"));
  try {
    return spawnSync(process.execPath, [COMPILE_CLI], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        MEMORY_DATA_DIR: dir,
        // Isolate compile's lock + state (.compile.lock / .compile-state.json /
        // .compile-state.json.log) into the temp dir too — they default to the
        // repo root, so without this the subprocess would write the working tree.
        MEMORY_COMPILE_STATE_DIR: dir,
        // A container that cannot exist forces `docker exec` to fail at the very
        // first bridge call; never targets the real ctxr-dev-memory container.
        MCP_CONTAINER_NAME: "ctxr-nonexistent-test-container-xyz",
        DIFY_FLUSH_DATASET: "daily",
        // Tiny lock-stale window so an orphaned .compile.lock (a prior crashed
        // or recently-run compile within the default 30m window) is reclaimed
        // instead of making compile exit 0 early via "skipping (lock held)" —
        // which would mask the exit-69 path this test asserts.
        MEMORY_COMPILE_LOCK_STALE_MS: "1",
        ...extraEnv,
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("compile exits 69 (EX_UNAVAILABLE) when the bridge is unreachable", () => {
  const r = runCompile();
  assert.equal(r.status, 69, `expected exit 69, got ${r.status}; stderr=${(r.stderr || "").slice(-300)}`);
  // The breadcrumb the synthetic-entity excerpt reads (it names the error class so
  // ENOENT vs timeout vs auth produce distinct escalation signatures downstream).
  assert.match(r.stderr || "", /compile\.mjs: aborting \(DifyBridgeUnavailable\)/);
  // Must NOT be the old silent-healthy exit 0.
  assert.notEqual(r.status, 0, "bridge-unavailable must not look clean");
});
