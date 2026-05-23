// Lock the shared re-entry guard in scripts/lib/reentry.mjs.
//
// The guard stops a memory hook from re-firing when the distiller (or
// compile) it spawned runs its own session inside the project. Two
// invariants matter: the check is presence-based (recognises ANY provider's
// distiller, not just claude) and back-compatible (the legacy
// CLAUDE_INVOKED_BY var still trips it).

import { test } from "node:test";
import assert from "node:assert/strict";

import { isReentrant, reentryEnv, REENTRY_VARS } from "../scripts/lib/reentry.mjs";

test("isReentrant: false when no guard var is set", () => {
  assert.equal(isReentrant({}), false);
});

test("isReentrant: false when guard vars are empty strings", () => {
  assert.equal(isReentrant({ MEMORY_HOOK_REENTRY: "", CLAUDE_INVOKED_BY: "" }), false);
});

test("isReentrant: true when the neutral var is set", () => {
  assert.equal(isReentrant({ MEMORY_HOOK_REENTRY: "memory-distill" }), true);
});

test("isReentrant: true when the legacy CLAUDE_INVOKED_BY is set (back-compat)", () => {
  assert.equal(isReentrant({ CLAUDE_INVOKED_BY: "memory_compile" }), true);
});

test("reentryEnv: sets every guard var to the tag and preserves base env", () => {
  const env = reentryEnv("memory-flush", { PATH: "/usr/bin", FOO: "bar" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.FOO, "bar");
  for (const name of REENTRY_VARS) assert.equal(env[name], "memory-flush");
});

test("reentryEnv: its output is recognised by isReentrant", () => {
  assert.equal(isReentrant(reentryEnv("memory-distill", {})), true);
});
