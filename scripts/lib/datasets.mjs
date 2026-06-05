// Central registry for atom types, dataset routing, and metadata schema.
// Both flush.mjs and compile.mjs import from here so the type list cannot
// drift between extraction and promotion.

export const ATOM_TYPES = new Set([
  "decision",
  "bug-root-cause",
  "feedback-rule",
  "project-lore",
  "reference",
  "pattern-gotcha",
  "self-improvement-lesson",
  // `plan` is set by the ExitPlanMode auto-capture hook and by manual
  // save_to_dataset calls into the `plans` slot. Compile never produces it
  // (plans are not extracted from transcripts), but it must be a known type
  // so future filtered retrieval can reach plans by atom_type without
  // tripping enum-validation paths.
  "plan",
]);

// Atom-type -> default dataset slot when promoted by compile.
// Inline `save_lesson` writes go directly to "self_improvement"; everything
// else routes through this table. Falls back to DIFY_COMPILE_DATASET when
// the type is not listed (forward-compat for new atom types).
export const ATOM_TYPE_TO_DATASET = {
  "decision": "knowledge",
  "bug-root-cause": "knowledge",
  "feedback-rule": "knowledge",
  "project-lore": "knowledge",
  "reference": "knowledge",
  "pattern-gotcha": "knowledge",
  "self-improvement-lesson": "self_improvement",
  "plan": "plans",
};

// Per-document metadata schema applied to every Dify dataset. Dify supports
// only string/number/time field types (no arrays); tags are stored as a
// comma-separated string queried with the `contains` operator.
//
// The trailing seven fields back the consolidate orchestrator + recall
// instrumentation (see scripts/consolidate.mjs, mcp-server/src/recall-stamp.js):
//   last_recalled_at / recall_count  — staleness signal stamped on recall.
//   superseded_by / consolidated_at  — merge bookkeeping on archived losers.
//   stale                            — persisted staleness flag ("true"/"false").
//   last_refreshed_at                — LLM-refresh rewrite marker.
//   consolidate_truncated_at         — compress-archived marker.
// Mirrored verbatim (name + type) in mcp-server/src/schema.js and
// scripts/dify-setup.sh; the parity test in test/datasets.test.mjs locks all
// three in lock-step.
export const METADATA_SCHEMA = [
  { name: "atom_type", type: "string" },
  { name: "tags", type: "string" },
  { name: "project_module", type: "string" },
  { name: "language", type: "string" },
  { name: "task_type", type: "string" },
  { name: "error_pattern", type: "string" },
  // All consolidate/recall fields are `string`: we never use Dify-side typed
  // (time/number) filtering on them, and all date/count parsing happens
  // client-side. Storing ISO timestamps + a numeric-string count in string
  // fields avoids any Dify type-coercion surprise on write.
  { name: "last_recalled_at", type: "string" },
  { name: "recall_count", type: "string" },
  { name: "superseded_by", type: "string" },
  { name: "consolidated_at", type: "string" },
  { name: "stale", type: "string" },
  { name: "last_refreshed_at", type: "string" },
  { name: "consolidate_truncated_at", type: "string" },
];

export const TASK_TYPES = new Set([
  "planning",
  "implementation",
  "debugging",
  "refactor",
  "review",
  "deploy",
  "docs",
  "unknown",
]);

export function routeAtomToDataset(atomType, fallback) {
  return ATOM_TYPE_TO_DATASET[atomType] || fallback;
}

// Normalise an atom's metadata block into the exact fields Dify will store.
// Tags array is joined with commas. Empty/absent fields are OMITTED so
// downstream filters never match `is ""` against entries that simply lack
// the field. atom_type is always present since the atom has a type.
export function metadataForDify(atom) {
  const md = (atom && typeof atom.metadata === "object" && atom.metadata) || {};
  const tagsField = Array.isArray(atom?.tags)
    ? atom.tags.map((t) => String(t).trim()).filter(Boolean).join(",")
    : String(md.tags || "").trim();
  const out = { atom_type: String(atom?.type || "").trim() };
  const maybe = (k, v) => {
    const cleaned = String(v || "").trim();
    if (cleaned) out[k] = cleaned;
  };
  if (tagsField) out.tags = tagsField;
  maybe("project_module", md.project_module);
  maybe("language", md.language);
  maybe("task_type", md.task_type);
  maybe("error_pattern", md.error_pattern);
  return out;
}
