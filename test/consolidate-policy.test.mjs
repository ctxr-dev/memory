// Lock the per-slot consolidate policy resolver: the RAG analog of llm-wiki's
// `consolidate: refine|none` layout gate. The refusal-on-undeclared-slot
// behaviour is the safety contract — consolidate must never guess that a bound
// slot should be mutated.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_CONSOLIDATE_DEFAULTS,
  consolidatePolicyEnvKey,
  parseConsolidatePolicy,
  boundSlotsFromEnv,
  resolveConsolidatePolicy,
  resolveAllPolicies,
} from "../mcp-server/src/consolidate-policy.js";

test("consolidatePolicyEnvKey: slot -> MEMORY_CONSOLIDATE_<UPPER_SNAKE>", () => {
  assert.equal(consolidatePolicyEnvKey("knowledge"), "MEMORY_CONSOLIDATE_KNOWLEDGE");
  assert.equal(consolidatePolicyEnvKey("self_improvement"), "MEMORY_CONSOLIDATE_SELF_IMPROVEMENT");
  assert.equal(consolidatePolicyEnvKey("my-runbooks"), "MEMORY_CONSOLIDATE_MY_RUNBOOKS");
});

test("parseConsolidatePolicy: refine/none accepted, case + whitespace normalised", () => {
  assert.equal(parseConsolidatePolicy("refine"), "refine");
  assert.equal(parseConsolidatePolicy("none"), "none");
  assert.equal(parseConsolidatePolicy("  REFINE  "), "refine");
  assert.equal(parseConsolidatePolicy("None"), "none");
});

test("parseConsolidatePolicy: empty/absent -> undefined", () => {
  assert.equal(parseConsolidatePolicy(""), undefined);
  assert.equal(parseConsolidatePolicy("   "), undefined);
  assert.equal(parseConsolidatePolicy(undefined), undefined);
  assert.equal(parseConsolidatePolicy(null), undefined);
});

test("parseConsolidatePolicy: invalid value throws (typo must be loud)", () => {
  assert.throws(() => parseConsolidatePolicy("refien"), /invalid consolidate policy/);
  assert.throws(() => parseConsolidatePolicy("yes"), /invalid consolidate policy/);
});

test("boundSlotsFromEnv: derives non-empty DIFY_DATASET_<NAME>_ID slots + legacy default", () => {
  const env = {
    DIFY_DATASET_KNOWLEDGE_ID: "k1",
    DIFY_DATASET_SELF_IMPROVEMENT_ID: "s1",
    DIFY_DATASET_EMPTY_ID: "   ", // empty binding ignored
    NOT_A_DATASET: "x",
    DIFY_WRITE_DATASET_ID: "legacy1",
  };
  const slots = boundSlotsFromEnv(env);
  assert.deepEqual(slots.sort(), ["default", "knowledge", "self_improvement"]);
});

test("resolveConsolidatePolicy: explicit line wins over built-in default", () => {
  assert.equal(
    resolveConsolidatePolicy("knowledge", { MEMORY_CONSOLIDATE_KNOWLEDGE: "none" }),
    "none",
  );
  // self_improvement default is refine; explicit none overrides.
  assert.equal(
    resolveConsolidatePolicy("self_improvement", { MEMORY_CONSOLIDATE_SELF_IMPROVEMENT: "none" }),
    "none",
  );
});

test("resolveConsolidatePolicy: built-in defaults are the locked canonical values", () => {
  assert.equal(resolveConsolidatePolicy("knowledge", {}), "refine");
  assert.equal(resolveConsolidatePolicy("self_improvement", {}), "refine");
  assert.equal(resolveConsolidatePolicy("plans", {}), "none");
  assert.equal(resolveConsolidatePolicy("investigations", {}), "none");
  assert.equal(resolveConsolidatePolicy("daily", {}), "none");
});

test("BUILTIN_CONSOLIDATE_DEFAULTS: exact canonical map", () => {
  assert.deepEqual({ ...BUILTIN_CONSOLIDATE_DEFAULTS }, {
    knowledge: "refine",
    self_improvement: "refine",
    plans: "none",
    investigations: "none",
    daily: "none",
  });
});

test("resolveConsolidatePolicy: undeclared custom slot -> undefined (refusal)", () => {
  assert.equal(resolveConsolidatePolicy("runbooks", {}), undefined);
});

test("resolveAllPolicies: built-in slots resolve; refine list is sorted", () => {
  const env = {
    DIFY_DATASET_KNOWLEDGE_ID: "k",
    DIFY_DATASET_SELF_IMPROVEMENT_ID: "s",
    DIFY_DATASET_PLANS_ID: "p",
    DIFY_DATASET_DAILY_ID: "d",
  };
  const { policies, refine, refusals } = resolveAllPolicies(env);
  assert.deepEqual(refusals, []);
  assert.deepEqual(refine, ["knowledge", "self_improvement"]);
  assert.equal(policies.plans, "none");
  assert.equal(policies.daily, "none");
});

test("resolveAllPolicies: undeclared bound slot -> aggregated refusal (does not stop at first)", () => {
  const env = {
    DIFY_DATASET_KNOWLEDGE_ID: "k",
    DIFY_DATASET_RUNBOOKS_ID: "r", // custom, no policy, no default
    DIFY_DATASET_NOTES_ID: "n", // another custom, no policy
  };
  const { refine, refusals } = resolveAllPolicies(env);
  assert.deepEqual(refine, ["knowledge"]);
  const refusedSlots = refusals.map((r) => r.slot).sort();
  assert.deepEqual(refusedSlots, ["notes", "runbooks"]);
  for (const r of refusals) {
    assert.match(r.envKey, /^MEMORY_CONSOLIDATE_/);
    assert.ok(r.reason);
  }
});

test("resolveAllPolicies: explicit refine on a custom slot is honoured", () => {
  const env = {
    DIFY_DATASET_RUNBOOKS_ID: "r",
    MEMORY_CONSOLIDATE_RUNBOOKS: "refine",
  };
  const { refine, refusals } = resolveAllPolicies(env);
  assert.deepEqual(refusals, []);
  assert.deepEqual(refine, ["runbooks"]);
});

test("resolveAllPolicies: invalid explicit value becomes a refusal, not a throw", () => {
  const env = {
    DIFY_DATASET_KNOWLEDGE_ID: "k",
    MEMORY_CONSOLIDATE_KNOWLEDGE: "bogus",
  };
  const { refine, refusals } = resolveAllPolicies(env);
  assert.deepEqual(refine, []);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].slot, "knowledge");
  assert.match(refusals[0].reason, /invalid consolidate policy/);
});

test("resolveAllPolicies: explicit slots arg overrides env-derived bound list", () => {
  const { refine } = resolveAllPolicies({}, ["knowledge", "plans"]);
  assert.deepEqual(refine, ["knowledge"]);
});
