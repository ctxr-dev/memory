// Lock the escalation dedup key: the SAME underlying bug must map to the SAME
// signature across runs/entities (volatile tokens stripped), while DIFFERENT root
// causes (e.g. ENOENT vs timeout) must map to DIFFERENT signatures so they open
// distinct episodes. Error CLASS names survive (they are the bug identity).

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeErrorSignature } from "../scripts/lib/error-signature.mjs";

test("stable across volatile tokens (ids, paths, hashes, numbers, timestamps)", () => {
  const a = normalizeErrorSignature("merge failed for leaf-abc123def456.md at 2026-06-05T10:00:00Z (3 retries)", { pass: "merge", kind: "leaf" });
  const b = normalizeErrorSignature("merge failed for leaf-999fedcba000.md at 2026-06-04T22:11:02Z (7 retries)", { pass: "merge", kind: "leaf" });
  assert.equal(a, b, "same bug, different volatile tokens -> same signature");
  assert.ok(a.length > 0 && a.length <= 80);
});

test("distinct root causes -> distinct signatures (ENOENT vs timeout)", () => {
  const enoent = normalizeErrorSignature("spawn claude ENOENT", { pass: "compile-promote", kind: "system-provider" });
  const timeout = normalizeErrorSignature("claude timed out after 120000ms", { pass: "compile-promote", kind: "system-provider" });
  assert.notEqual(enoent, timeout, "different causes must open different episodes");
});

test("error CLASS names survive (they are the bug identity)", () => {
  const sig = normalizeErrorSignature("aborting (DifyBridgeUnavailable): memory-cli list exited 1", { pass: "compile-promote" });
  assert.match(sig, /difybridgeunavailable/);
});

test("empty / nullish -> a stable fallback slug", () => {
  assert.equal(normalizeErrorSignature("", {}), "unknown-error");
  assert.equal(normalizeErrorSignature(null, {}), "unknown-error");
});

test("pass + kind prefix the signature (so the same text in different passes differs)", () => {
  const m = normalizeErrorSignature("write failed", { pass: "merge", kind: "leaf" });
  const r = normalizeErrorSignature("write failed", { pass: "refresh", kind: "leaf" });
  assert.notEqual(m, r);
  assert.match(m, /^merge-/);
  assert.match(r, /^refresh-/);
});
