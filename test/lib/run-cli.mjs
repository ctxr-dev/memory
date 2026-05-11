// Shared test helper: spawn a hook .mjs as a child process with
// controlled stdin + env. Strips every env var prefix that any hook
// might consume, so a developer who exports e.g.
// MEMORY_HOOK_EXITPLANMODE_DISABLE=true in their shell doesn't
// silently flip tests to "pass for the wrong reason." Then layers
// caller-supplied overrides back on top.
//
// Usage:
//   const r = runCli(MJS_PATH, payload, { DIFY_DATASET_PLANS_ID: "..." });
//   assert.equal(r.status, 0);
//   assert.match(r.stderr, /skipped/);
//
// Strip prefixes are conservative and overlap (e.g. MEMORY_HOOK_* is a
// subset of MEMORY_*); the redundancy is intentional so a future
// reviewer scanning this file sees exactly which env-var families the
// hooks read.

import { spawnSync } from "node:child_process";

const STRIP_PREFIXES = ["DIFY_DATASET_", "MEMORY_HOOK_", "DIFY_", "MEMORY_"];
const STRIP_EXACT = new Set(["MCP_CONTAINER_NAME"]);

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
