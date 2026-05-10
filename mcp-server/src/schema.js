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
