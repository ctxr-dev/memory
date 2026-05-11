// Shared test helper: spawn a hook .mjs as a child process with
// controlled stdin + env. Strips every env var prefix that any hook or
// install script might consume, so a developer who exports e.g.
// MEMORY_HOOK_EXITPLANMODE_DISABLE=true in their shell doesn't
// silently flip tests to "pass for the wrong reason." Then layers
// caller-supplied overrides back on top.
//
// Usage:
//   const r = runCli(MJS_PATH, payload, { DIFY_DATASET_PLANS_ID: "..." });
//   assert.equal(r.status, 0);
//   assert.match(r.stderr, /skipped/);
//
// **The redundancy in STRIP_PREFIXES is INTENTIONAL.** `DIFY_DATASET_`
// is a subset of `DIFY_`, and `MEMORY_HOOK_` is a subset of `MEMORY_`.
// Listing the narrower prefix alongside the broader one documents the
// env-var families the hooks read; do NOT prune for "elegance" or a
// future contributor will look at `MEMORY_` and wonder which subset it
// covers.
//
// **MEMORY_DATA_DIR is stripped** as part of MEMORY_*. Tests that need
// to control the absorb-flow's workspace mount must pass it through
// `envOverrides`.
//
// **Tests for this helper live in `test/lib-helpers.test.mjs` at the
// test root (NOT in test/lib/), because the test glob in package.json
// is `test/*.test.mjs` and does not recurse into test/lib/.**
//
// Common pattern: a per-test-file wrapper that pins the .mjs path:
//   import { runCli as runCliShared } from "./lib/run-cli.mjs";
//   const MJS = path.resolve(...);
//   function runCli(stdin, env) { return runCliShared(MJS, stdin, env); }

import { spawnSync } from "node:child_process";

const STRIP_PREFIXES = ["DIFY_DATASET_", "MEMORY_HOOK_", "DIFY_", "MEMORY_"];
// Exact-match strip list. CLAUDE_PROJECT_DIR is referenced by every
// hook command in templates/claude/settings.json; COMPOSE_PROJECT_NAME
// is read by scripts/lib.sh. Both should NOT leak from the developer's
// shell into hermetic hook tests.
const STRIP_EXACT = new Set([
  "MCP_CONTAINER_NAME",
  "CLAUDE_PROJECT_DIR",
  "COMPOSE_PROJECT_NAME",
]);

export function runCli(mjsPath, stdin, envOverrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (STRIP_EXACT.has(key) || STRIP_PREFIXES.some((p) => key.startsWith(p))) {
      delete env[key];
    }
  }
  Object.assign(env, envOverrides);
  const r = spawnSync("node", [mjsPath], {
    input: stdin,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}
