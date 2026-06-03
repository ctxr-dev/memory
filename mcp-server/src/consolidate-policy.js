// Per-slot consolidate policy resolver.
//
// The RAG analog of llm-wiki-memory's per-category `consolidate: refine|none`
// layout field (and its `layout-missing-consolidate-field` refusal). Dify has
// no layout file; slots are bound dynamically via DIFY_DATASET_<NAME>_ID env
// lines, so the policy is declared per-slot via MEMORY_CONSOLIDATE_<SLOT> lines
// with built-in defaults for the canonical slots.
//
// Resolution order for a bound slot:
//   1. explicit MEMORY_CONSOLIDATE_<SLOT>=refine|none
//   2. else a BUILTIN_CONSOLIDATE_DEFAULTS entry
//   3. else REFUSE (return it in `refusals`) — consolidate will not guess.
//
// Pure + dependency-free (no Dify import) so it unit-tests in isolation; the
// host engine and the read-only MCP projector both call resolveAllPolicies with
// an env snapshot. `refine` slots are walked/mutated; `none` slots are left
// untouched (owned by other lifecycles: plans / investigations / daily).

export const CONSOLIDATE_POLICIES = Object.freeze(["refine", "none"]);

// Built-in policy for the canonical slots. A bound slot that is NOT listed here
// AND has no explicit MEMORY_CONSOLIDATE_<SLOT> line triggers a refusal — the
// operator must declare custom slots explicitly (safe default: never guess
// "mutate this dataset").
export const BUILTIN_CONSOLIDATE_DEFAULTS = Object.freeze({
  knowledge: "refine",
  self_improvement: "refine",
  plans: "none",
  investigations: "none",
  daily: "none",
});

// The MEMORY_CONSOLIDATE_<SLOT> env-var name for a slot. Mirrors the tokeniser
// in env.mjs:slotEnvKey (lowercase + non-alphanumerics -> "_", uppercased) so
// `self_improvement` -> MEMORY_CONSOLIDATE_SELF_IMPROVEMENT and a hyphenated
// custom slot `my-runbooks` -> MEMORY_CONSOLIDATE_MY_RUNBOOKS.
export function consolidatePolicyEnvKey(slot) {
  const tag = String(slot || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `MEMORY_CONSOLIDATE_${tag}`;
}

// Normalise one policy value. Returns "refine"|"none", undefined for
// empty/absent, and THROWS on any other non-empty value (a typo must be loud,
// not silently treated as "none").
export function parseConsolidatePolicy(raw) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "refine" || v === "none") return v;
  throw new Error(`invalid consolidate policy '${raw}' (expected 'refine' or 'none')`);
}

// Derive the bound slot names from a DIFY_DATASET_<NAME>_ID env map. Mirrors
// dify.js:buildDatasetMap's primary regex; only non-empty ids count as bound
// (an empty binding is not a real dataset). Legacy DIFY_WRITE_DATASET_ID maps
// to the "default" slot for parity with buildDatasetMap.
export function boundSlotsFromEnv(env = {}) {
  const slots = [];
  const seen = new Set();
  for (const key of Object.keys(env)) {
    const m = key.match(/^DIFY_DATASET_(.+)_ID$/);
    if (!m) continue;
    const slot = m[1].toLowerCase();
    if (seen.has(slot)) continue;
    if (!String(env[key] || "").trim()) continue;
    seen.add(slot);
    slots.push(slot);
  }
  const legacy = String(env.DIFY_WRITE_DATASET_ID || "").trim();
  if (legacy && !seen.has("default")) slots.push("default");
  return slots;
}

// Resolve one slot's policy. Returns "refine"|"none", or undefined when neither
// an explicit line nor a built-in default applies (the caller treats undefined
// as a refusal). Throws (via parseConsolidatePolicy) on an invalid explicit value.
export function resolveConsolidatePolicy(slot, env = {}) {
  const explicit = parseConsolidatePolicy(env[consolidatePolicyEnvKey(slot)]);
  if (explicit) return explicit;
  const builtin = BUILTIN_CONSOLIDATE_DEFAULTS[slot];
  if (builtin) return builtin;
  return undefined;
}

// Resolve every bound slot. Returns:
//   { policies: { slot: "refine"|"none" }, refine: [slots], refusals: [{slot, envKey, reason}] }
// Refusals are AGGREGATED (resolution does not stop at the first), so the
// operator sees every slot that needs a declaration in one run. `refine` is
// sorted for deterministic walk order. Pass `slots` to override the env-derived
// bound-slot list (e.g. the container projector resolving via buildDatasetMap).
export function resolveAllPolicies(env = {}, slots) {
  const boundSlots = Array.isArray(slots) ? slots : boundSlotsFromEnv(env);
  const policies = {};
  const refine = [];
  const refusals = [];
  for (const slot of boundSlots) {
    let policy;
    try {
      policy = resolveConsolidatePolicy(slot, env);
    } catch (err) {
      refusals.push({
        slot,
        envKey: consolidatePolicyEnvKey(slot),
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!policy) {
      refusals.push({
        slot,
        envKey: consolidatePolicyEnvKey(slot),
        reason: "no MEMORY_CONSOLIDATE_<SLOT> line and no built-in default; declare 'refine' or 'none'",
      });
      continue;
    }
    policies[slot] = policy;
    if (policy === "refine") refine.push(slot);
  }
  refine.sort();
  return { policies, refine, refusals };
}
