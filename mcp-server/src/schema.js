// Per-document metadata fields installed on every dataset created via the
// `create_dataset` MCP tool. Mirrors scripts/lib/datasets.mjs:METADATA_SCHEMA
// (the bridge module is a separate Node module without import access to
// scripts/lib/, so the constant is duplicated). Locked by the parity test
// in test/datasets.test.mjs — that test imports both ends and asserts they
// list the same field names in the same order.
//
// If you add or remove a field, update BOTH files and the parity test will
// pass automatically; if you only update one, the test fails with a clear
// drift message.
export const PER_DOC_METADATA_FIELDS = [
  "atom_type",
  "tags",
  "project_module",
  "language",
  "task_type",
  "error_pattern",
];

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
