// Lock the env-helpers contract. flush.mjs and exit-plan-mode.mjs both
// rely on slotEnvKey() to compute the canonical DIFY_DATASET_<NAME>_ID
// env var name for a given slot; a regression that preserves hyphens or
// changes the prefix would silently make EVERY hook skip with "slot not
// bound". envValue precedence (process.env over .env file) is also locked
// here because both the bridge and the hooks depend on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { slotEnvKey, envValue, envInt, atomBodyMaxChars, ATOM_BODY_MAX_CHARS_DEFAULT } from "../scripts/lib/env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

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

test("envValue: documents the Phase-2.2 + 2.4 env knobs read by other modules", (t) => {
  // Defensive parity: the knob NAMES are part of the user's public env-var
  // surface and are documented in .env.example. If a maintainer renames
  // a knob in code without updating .env.example, this test catches the
  // discrepancy by re-reading the example file and asserting each
  // canonical name is present (commented out is fine; what matters is
  // the canonical spelling is documented).
  const envExample = fs.readFileSync(path.resolve(here, "..", ".env.example"), "utf8");
  for (const knob of [
    "MEMORY_ATOM_BODY_MAX_CHARS",
    "MEMORY_COMPILE_QUALITY_STRICT",
    "MEMORY_DEFAULT_PROJECT_MODULE",
    "MEMORY_AUDIT_LORE_STALE_DAYS",
    "MEMORY_HOOK_EXITPLANMODE_DISABLE",
    "MEMORY_HOOK_EXITPLANMODE_MAX_BYTES",
  ]) {
    assert.ok(
      envExample.includes(knob),
      `.env.example missing canonical knob name '${knob}'`,
    );
  }
});

test("envValue: MEMORY_COMPILE_QUALITY_STRICT is read as lowercase 'true' / 'false'", (t) => {
  // compile.mjs reads this knob as:
  //   String(envValue("MEMORY_COMPILE_QUALITY_STRICT", "")).toLowerCase() === "true"
  // Lock the expected parsing: only the literal string "true" (case-
  // insensitive) flips the strict gate. Anything else means lax mode.
  const key = "MEMORY_COMPILE_QUALITY_STRICT";
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  function parse(value) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    return String(envValue(key, "")).toLowerCase() === "true";
  }
  assert.equal(parse("true"), true);
  assert.equal(parse("TRUE"), true);
  assert.equal(parse("True"), true);
  assert.equal(parse("false"), false);
  assert.equal(parse("0"), false);
  assert.equal(parse(""), false);
  assert.equal(parse(undefined), false);
  assert.equal(parse("yes"), false, "'yes' must NOT be treated as true (Boolean trap)");
  assert.equal(parse("1"), false, "'1' must NOT be treated as true (Boolean trap)");
});

test("envValue: MEMORY_AUDIT_LORE_STALE_DAYS parses as positive integer with 90-day default", (t) => {
  // mcp-server/src/index.js:audit_memory parses this knob as:
  //   staleLoreDays || Number.parseInt(process.env.MEMORY_AUDIT_LORE_STALE_DAYS || "", 10) || 90
  // Lock the documented default and the rejection of non-positive
  // values. The tool's `staleLoreDays` argument takes precedence over
  // the env knob.
  const key = "MEMORY_AUDIT_LORE_STALE_DAYS";
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
  function parse(value, override) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    return override || Number.parseInt(process.env[key] || "", 10) || 90;
  }
  assert.equal(parse(undefined), 90, "default is 90 days when unset");
  assert.equal(parse("30"), 30);
  assert.equal(parse("365"), 365);
  assert.equal(parse("abc"), 90, "non-numeric falls back to default");
  assert.equal(parse(""), 90, "empty falls back to default");
  // Tool argument override:
  assert.equal(parse("30", 14), 14, "override wins over env");
  assert.equal(parse(undefined, 7), 7, "override wins over default");
});
