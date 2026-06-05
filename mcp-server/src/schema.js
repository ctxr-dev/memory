// Per-document metadata fields installed on every dataset created via the
// `create_dataset` MCP tool. Mirrors scripts/lib/datasets.mjs:METADATA_SCHEMA
// (the bridge module is a separate Node module without import access to
// scripts/lib/, so the constant is duplicated). Locked by the parity test
// in test/datasets.test.mjs — that test imports both ends and asserts they
// list the same field names (and types) in the same order.
//
// PER_DOC_METADATA_SCHEMA is the typed source of truth in this runtime;
// PER_DOC_METADATA_FIELDS is the derived name list (kept as a named export
// so existing consumers + the name-parity test are unaffected). Dify supports
// only string/number/time field types. If you add or remove a field, update
// BOTH files and dify-setup.sh; the parity test catches drift.
export const PER_DOC_METADATA_SCHEMA = [
  { name: "atom_type", type: "string" },
  { name: "tags", type: "string" },
  { name: "project_module", type: "string" },
  { name: "language", type: "string" },
  { name: "task_type", type: "string" },
  { name: "error_pattern", type: "string" },
  // All consolidate/recall fields are `string` (ISO timestamps + numeric-string
  // count); parsing is client-side, so no Dify-typed (time/number) field is
  // needed. Keep in lock-step with scripts/lib/datasets.mjs:METADATA_SCHEMA.
  { name: "last_recalled_at", type: "string" },
  { name: "recall_count", type: "string" },
  { name: "superseded_by", type: "string" },
  { name: "consolidated_at", type: "string" },
  { name: "stale", type: "string" },
  { name: "last_refreshed_at", type: "string" },
  { name: "consolidate_truncated_at", type: "string" },
];

export const PER_DOC_METADATA_FIELDS = PER_DOC_METADATA_SCHEMA.map((f) => f.name);

// Atom-type registry: every type known to flush+compile + the hook-set
// `plan` type. Bridge-side mirror of scripts/lib/datasets.mjs:ATOM_TYPES.
// Round-33 added "plan" host-side but the bridge had no registry; the
// bridge instead hardcoded specific subsets at four call sites in
// index.js, which silently diverged from the host source of truth.
// Locked by a parity test in test/datasets.test.mjs alongside the
// metadata-field parity check.
//
// If you add or remove an atom type, update BOTH files; the parity test
// catches drift with a clear failure message.
export const ATOM_TYPES = [
  "decision",
  "bug-root-cause",
  "feedback-rule",
  "project-lore",
  "reference",
  "pattern-gotcha",
  "self-improvement-lesson",
  "plan",
];

// Subset used by save_lesson: only atoms with this type are lessons.
// Defined as a named constant rather than a literal so the wire
// contract is visible at a glance.
export const LESSON_ATOM_TYPE = "self-improvement-lesson";

// Subset surfaced by recall_lessons' `includeKnowledge` companion
// pass: when present, recall pulls top hits from `knowledge` of these
// types alongside the lessons.
export const KNOWLEDGE_CROSSREF_ATOM_TYPES = ["bug-root-cause", "feedback-rule"];
