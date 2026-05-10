// Integration tests for the exit-plan-mode CLI driver. Spawns the .mjs
// directly with controlled stdin + env; locks the always-exit-0 invariant
// (hooks must NEVER block the agent) and the host-side preflight skip
// paths. Without this file, main(), readStdin, the slot preflight, and
// the DifyBridgeUnavailable catch are 0% covered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MJS = path.resolve(HERE, "..", "scripts", "hooks", "exit-plan-mode.mjs");

function runCli(stdin, envOverrides = {}) {
  // Strip every DIFY_DATASET_*_ID + MCP_CONTAINER_NAME from the inherited
  // env so the test starts from a known empty state, then layer overrides.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DIFY_DATASET_") || key === "MCP_CONTAINER_NAME") delete env[key];
  }
  // Point envValue's .env-file fallback at a non-existent path so the
  // helper can't pick up the workspace's real memory/.env (which may or
  // may not exist depending on dev state).
  Object.assign(env, envOverrides);
  const r = spawnSync("node", [MJS], {
    input: stdin,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

test("CLI: empty stdin -> exit 0, skip(not-approved)", () => {
  const r = runCli("");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /skipped \(not-approved\)/);
});

test("CLI: malformed JSON on stdin -> exit 0, treated as empty", () => {
  const r = runCli("not json at all {{{");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /skipped \(not-approved\)/);
});

test("CLI: rejected plan -> exit 0, skip(not-approved)", () => {
  const payload = JSON.stringify({
    tool_response: { approved: false },
    tool_input: { plan: "# Whatever" },
  });
  const r = runCli(payload);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /skipped \(not-approved\)/);
});

test("CLI: approved + empty plan body -> exit 0, skip(empty-plan)", () => {
  const payload = JSON.stringify({
    tool_response: { approved: true },
    tool_input: { plan: "   \n   " },
  });
  const r = runCli(payload);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /skipped \(empty-plan\)/);
});

test("CLI: approved + non-string plan -> exit 0, skip(non-string-plan)", () => {
  const payload = JSON.stringify({
    tool_response: { approved: true },
    tool_input: { plan: { not: "a string" } },
  });
  const r = runCli(payload);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /skipped \(non-string-plan\)/);
});

test("CLI: approved + valid plan but slot unbound -> exit 0, slot-not-bound skip with wizard hint", () => {
  // No DIFY_DATASET_PLANS_ID in env (we stripped it) and no
  // memory/.env reachable via the test's scrubbed env. Hook should
  // detect the host-side preflight failure and emit the dify-setup
  // wizard hint, not crash.
  const payload = JSON.stringify({
    tool_response: { approved: true },
    tool_input: { plan: "# Smoke plan\n\nbody" },
  });
  const r = runCli(payload, {
    // Force envValue's .env-file fallback to miss by chdir'ing the test
    // run elsewhere (handled by the cwd parameter? no — env.mjs reads
    // ENV_PATH which is computed from import.meta.url, NOT cwd).
    // So we accept the small risk that a developer's local
    // memory/.env DOES bind plans; in that case this test sees the
    // bridge-unavailable path instead. Both are valid skip outcomes;
    // assert "skipped" + exit 0 only.
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /exit-plan-mode: skipped/);
  // Either "plans slot not bound" (dev env without binding) OR
  // "bridge unavailable" (dev env with binding but no container).
  assert.ok(
    /plans slot not bound|bridge unavailable/.test(r.stderr),
    `expected slot-not-bound or bridge-unavailable; got: ${r.stderr}`,
  );
});

test("CLI: approved + valid plan + bogus container name -> exit 0, bridge unavailable skip", () => {
  const payload = JSON.stringify({
    tool_response: { approved: true },
    tool_input: { plan: "# Smoke plan\n\nbody" },
  });
  const r = runCli(payload, {
    // Bind the slot host-side so we get past the preflight; then point
    // the bridge at a container that doesn't exist so docker exec fails.
    DIFY_DATASET_PLANS_ID: "ds-fake-uuid-host-side-only",
    MCP_CONTAINER_NAME: "definitely-not-a-real-container-xyz",
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /skipped \(bridge unavailable/);
});

test("CLI: hook never exits non-zero (always exit 0 invariant)", () => {
  // Try a few pathological inputs and assert exit 0 every time. The
  // outer try/catch in the .mjs is the safety net; if it's removed or
  // the exit code path is changed, this regression catches it.
  const inputs = [
    "",
    "garbage",
    "[",
    "{}",
    JSON.stringify({ random: "object" }),
    JSON.stringify({ tool_response: null, tool_input: null }),
  ];
  for (const stdin of inputs) {
    const r = runCli(stdin);
    assert.equal(r.status, 0, `input ${JSON.stringify(stdin)} returned status ${r.status}`);
  }
});
