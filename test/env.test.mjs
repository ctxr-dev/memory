// Lock the env-helpers contract. flush.mjs and exit-plan-mode.mjs both
// rely on slotEnvKey() to compute the canonical DIFY_DATASET_<NAME>_ID
// env var name for a given slot; a regression that preserves hyphens or
// changes the prefix would silently make EVERY hook skip with "slot not
// bound". envValue precedence (process.env over .env file) is also locked
// here because both the bridge and the hooks depend on it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { slotEnvKey, envValue, envInt, atomBodyMaxChars, ATOM_BODY_MAX_CHARS_DEFAULT } from "../scripts/lib/env.mjs";

test("slotEnvKey: lowercase slot -> DIFY_DATASET_<UPPER>_ID", () => {
  assert.equal(slotEnvKey("plans"), "DIFY_DATASET_PLANS_ID");
  assert.equal(slotEnvKey("knowledge"), "DIFY_DATASET_KNOWLEDGE_ID");
  assert.equal(slotEnvKey("self_improvement"), "DIFY_DATASET_SELF_IMPROVEMENT_ID");
});

test("slotEnvKey: hyphenated slot -> underscores in env var", () => {
  // Without the punctuation collapse, DIFY_DATASET_MY-RUNBOOKS_ID is an
  // invalid var name and would never resolve. flush.mjs and
  // exit-plan-mode.mjs both depend on this normalisation.
  assert.equal(slotEnvKey("my-runbooks"), "DIFY_DATASET_MY_RUNBOOKS_ID");
  assert.equal(slotEnvKey("foo-bar-baz"), "DIFY_DATASET_FOO_BAR_BAZ_ID");
});

test("slotEnvKey: mixed-case input is uppercased", () => {
  assert.equal(slotEnvKey("PlAnS"), "DIFY_DATASET_PLANS_ID");
});

test("slotEnvKey: punctuation other than alphanumerics collapses to underscores", () => {
  assert.equal(slotEnvKey("a.b/c"), "DIFY_DATASET_A_B_C_ID");
  assert.equal(slotEnvKey("foo bar"), "DIFY_DATASET_FOO_BAR_ID");
});

test("slotEnvKey: empty / null / undefined / non-string -> stub var name (caller must validate)", () => {
  // We do NOT want this to throw: callers always read the result via
  // envValue() which will return "" for an unbound stub var, producing
  // the standard "slot not bound" skip. Throwing here would crash the
  // hook before it could emit the breadcrumb.
  assert.equal(slotEnvKey(""), "DIFY_DATASET__ID");
  assert.equal(slotEnvKey(null), "DIFY_DATASET__ID");
  assert.equal(slotEnvKey(undefined), "DIFY_DATASET__ID");
  assert.equal(slotEnvKey(123), "DIFY_DATASET_123_ID");
});

test("envValue: process.env wins over .env file", (t) => {
  const key = "MEMORY_TEST_ENV_PRECEDENCE_LOCK";
  const prev = process.env[key];
  process.env[key] = "from-process";
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  assert.equal(envValue(key, "fallback"), "from-process");
});

test("envValue: empty process.env value falls through to file/fallback", (t) => {
  const key = "MEMORY_TEST_ENV_EMPTY_FALLTHROUGH";
  const prev = process.env[key];
  process.env[key] = "";
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  // The file lookup may also return "" (no MEMORY_TEST_... in any .env);
  // the contract is that the fallback wins.
  assert.equal(envValue(key, "fallback"), "fallback");
});

test("envValue: unset key returns fallback", () => {
  assert.equal(envValue("MEMORY_TEST_DEFINITELY_NOT_SET_XYZ", "default"), "default");
  assert.equal(envValue("MEMORY_TEST_DEFINITELY_NOT_SET_XYZ"), "");
});

test("envInt: valid positive integer parses", (t) => {
  const key = "MEMORY_TEST_ENV_INT_VALID";
  const prev = process.env[key];
  process.env[key] = "42";
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  assert.equal(envInt(key, 7), 42);
});

test("envInt: zero / negative / NaN / unset all fall back", (t) => {
  const key = "MEMORY_TEST_ENV_INT_BOGUS";
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  for (const bad of ["0", "-3", "abc", ""]) {
    process.env[key] = bad;
    assert.equal(envInt(key, 99), 99, `value '${bad}' should fall back`);
  }
  delete process.env[key];
  assert.equal(envInt(key, 99), 99);
});

test("atomBodyMaxChars: default is 700 chars", () => {
  // Locked: both flush.mjs:validateAtoms (post-LLM truncation) and the
  // compile prompt (template substitution) read this value. A change
  // here cascades to retrieval recall AND prompt token budget — keep
  // intentional.
  const prev = process.env.MEMORY_ATOM_BODY_MAX_CHARS;
  delete process.env.MEMORY_ATOM_BODY_MAX_CHARS;
  try {
    assert.equal(ATOM_BODY_MAX_CHARS_DEFAULT, 700);
    assert.equal(atomBodyMaxChars(), 700);
  } finally {
    if (prev !== undefined) process.env.MEMORY_ATOM_BODY_MAX_CHARS = prev;
  }
});

test("atomBodyMaxChars: env override wins; invalid override falls back to default", (t) => {
  const key = "MEMORY_ATOM_BODY_MAX_CHARS";
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  process.env[key] = "500";
  assert.equal(atomBodyMaxChars(), 500);
  process.env[key] = "1200";
  assert.equal(atomBodyMaxChars(), 1200);
  for (const bad of ["0", "-3", "abc"]) {
    process.env[key] = bad;
    assert.equal(atomBodyMaxChars(), ATOM_BODY_MAX_CHARS_DEFAULT, `'${bad}' should fall back`);
  }
});
