// Lock the upgrade-merge contract. On `git pull`, bootstrap appends keys
// that exist in the clone-root .env.example but are missing from the user's canonical
// ./.memory/settings/.env, so new knobs surface without a hand-diff. The
// merge MUST be append-only (never touch existing user values), MUST treat a
// commented key in either file as "present", MUST preserve commented-vs-active
// form of appended lines, and MUST be idempotent.

import { test } from "node:test";
import assert from "node:assert/strict";

import { keyOf, declaredKeys, mergeEnvTemplate } from "../scripts/lib/merge-env.mjs";

const FIXED = new Date("2026-05-22T00:00:00Z");

test("keyOf: active, commented, and non-key lines", () => {
  assert.equal(keyOf("DIFY_KNOWLEDGE_API_KEY=abc"), "DIFY_KNOWLEDGE_API_KEY");
  assert.equal(keyOf("# MEMORY_HOOK_EXITPLANMODE_DISABLE=true"), "MEMORY_HOOK_EXITPLANMODE_DISABLE");
  assert.equal(keyOf("#   MEMORY_DATA_DIR=/x"), "MEMORY_DATA_DIR");
  assert.equal(keyOf("# just a prose comment"), null);
  assert.equal(keyOf(""), null);
  assert.equal(keyOf("not an assignment"), null);
});

test("declaredKeys: collects active and commented keys", () => {
  const keys = declaredKeys("A=1\n# B=2\n\n# prose\nC=3");
  assert.deepEqual([...keys].sort(), ["A", "B", "C"]);
});

test("mergeEnvTemplate: appends only missing keys, preserves existing values", () => {
  const template = "A=default\nB=tmpl\n# C=opt\nD=new";
  const target = "A=user-edited\nB=also-user\n# C=opt";
  const { merged, addedKeys } = mergeEnvTemplate(template, target, { now: FIXED });
  assert.deepEqual(addedKeys, ["D"]);
  // existing user values are untouched
  assert.match(merged, /^A=user-edited$/m);
  assert.match(merged, /^B=also-user$/m);
  // the new key is appended under a dated header
  assert.match(merged, /# ---- New keys merged from \.env\.example on 2026-05-22 ----/);
  assert.match(merged, /^D=new$/m);
});

test("mergeEnvTemplate: a key commented in target counts as present (not re-added)", () => {
  const template = "MEMORY_HOOK_EXITPLANMODE_DISABLE=true";
  const target = "# MEMORY_HOOK_EXITPLANMODE_DISABLE=true";
  const { merged, addedKeys } = mergeEnvTemplate(template, target, { now: FIXED });
  assert.deepEqual(addedKeys, []);
  assert.equal(merged, target);
});

test("mergeEnvTemplate: appended commented key keeps its commented form", () => {
  const template = "# OPTIONAL_KNOB=123";
  const target = "A=1";
  const { merged, addedKeys } = mergeEnvTemplate(template, target, { now: FIXED });
  assert.deepEqual(addedKeys, ["OPTIONAL_KNOB"]);
  assert.match(merged, /^# OPTIONAL_KNOB=123$/m);
});

test("mergeEnvTemplate: idempotent (second pass over merged output adds nothing)", () => {
  const template = "A=1\nB=2\n# C=3";
  const target = "A=user";
  const first = mergeEnvTemplate(template, target, { now: FIXED });
  assert.deepEqual(first.addedKeys.sort(), ["B", "C"]);
  const second = mergeEnvTemplate(template, first.merged, { now: FIXED });
  assert.deepEqual(second.addedKeys, []);
  assert.equal(second.merged, first.merged);
});

test("mergeEnvTemplate: CRLF target keeps CRLF and stays append-only", () => {
  const template = "A=1\nB=2";
  const target = "A=user\r\n";
  const { merged, addedKeys } = mergeEnvTemplate(template, target, { now: FIXED });
  assert.deepEqual(addedKeys, ["B"]);
  assert.ok(merged.startsWith(target), "original bytes preserved (append-only)");
  // No lone-LF lines introduced: every newline is part of a CRLF pair.
  assert.equal(merged.replace(/\r\n/g, "").includes("\n"), false, "no mixed LF among CRLF");
  assert.match(merged, /B=2\r\n$/);
});

test("mergeEnvTemplate: template key appearing twice is added once", () => {
  const template = "X=active\n# X=commented-dup\nY=keep";
  const target = "Z=1";
  const { addedKeys } = mergeEnvTemplate(template, target, { now: FIXED });
  assert.deepEqual(addedKeys, ["X", "Y"]);
});
