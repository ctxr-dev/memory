// Lock the metadata-field backfill CLI's pure surface: arg parsing (incl. the
// exit-3 user-error path) and the idempotent missing-field diff.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  diffMissingFields,
  fieldNamesFromResponse,
  InstallError,
} from "../scripts/install-metadata-fields.mjs";
import { METADATA_SCHEMA } from "../scripts/lib/datasets.mjs";

test("parseArgs: defaults", () => {
  const o = parseArgs([]);
  assert.equal(o.dryRun, false);
  assert.equal(o.datasetId, null);
  assert.equal(o.help, false);
});

test("parseArgs: --dry-run / -n and --datasetId", () => {
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["-n"]).dryRun, true);
  assert.equal(parseArgs(["--datasetId=knowledge"]).datasetId, "knowledge");
});

test("parseArgs: unknown arg throws InstallError with exitCode 3", () => {
  try {
    parseArgs(["--bogus"]);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof InstallError);
    assert.equal(err.exitCode, 3);
  }
});

test("diffMissingFields: returns exactly the schema entries not yet present", () => {
  // Only the 6 original fields present -> the 7 consolidate/recall fields missing.
  const present = ["atom_type", "tags", "project_module", "language", "task_type", "error_pattern"];
  const missing = diffMissingFields(present);
  assert.deepEqual(
    missing.map((f) => f.name),
    ["last_recalled_at", "recall_count", "superseded_by", "consolidated_at", "stale", "last_refreshed_at", "consolidate_truncated_at"],
  );
  // each carries its type
  for (const f of missing) assert.equal(typeof f.type, "string");
});

test("diffMissingFields: all present -> empty (idempotent)", () => {
  const present = METADATA_SCHEMA.map((f) => f.name);
  assert.deepEqual(diffMissingFields(present), []);
});

test("diffMissingFields: none present -> full schema", () => {
  assert.equal(diffMissingFields([]).length, METADATA_SCHEMA.length);
});

test("fieldNamesFromResponse: flattens the Dify list-metadata-fields shape", () => {
  const res = { doc_metadata: [{ id: "1", name: "atom_type", type: "string" }, { id: "2", name: "tags", type: "string" }, { bad: true }] };
  assert.deepEqual(fieldNamesFromResponse(res), ["atom_type", "tags"]);
  assert.deepEqual(fieldNamesFromResponse(null), []);
  assert.deepEqual(fieldNamesFromResponse({}), []);
});
