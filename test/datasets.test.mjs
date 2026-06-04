// Lock the atom-type registry, dataset routing table, and metadata
// normaliser. compile.mjs and flush.mjs both depend on these contracts; a
// silent change here would break promotion routing or downstream filters.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ATOM_TYPES,
  ATOM_TYPE_TO_DATASET,
  METADATA_SCHEMA,
  metadataForDify,
  routeAtomToDataset,
} from "../scripts/lib/datasets.mjs";
import { PER_DOC_METADATA_FIELDS, PER_DOC_METADATA_SCHEMA, ATOM_TYPES as BRIDGE_ATOM_TYPES, LESSON_ATOM_TYPE, KNOWLEDGE_CROSSREF_ATOM_TYPES } from "../mcp-server/src/schema.js";

test("ATOM_TYPES: stable known set", () => {
  const expected = [
    "decision",
    "bug-root-cause",
    "feedback-rule",
    "project-lore",
    "reference",
    "pattern-gotcha",
    "self-improvement-lesson",
    // `plan` was added when the ExitPlanMode auto-capture hook landed; it
    // is set on plans (compile never produces it) and routes to `plans`.
    "plan",
  ];
  for (const t of expected) {
    assert.ok(ATOM_TYPES.has(t), `missing atom type: ${t}`);
  }
  assert.equal(ATOM_TYPES.size, expected.length);
});

test("ATOM_TYPE_TO_DATASET: every atom type routes to a slot", () => {
  for (const t of ATOM_TYPES) {
    assert.ok(
      typeof ATOM_TYPE_TO_DATASET[t] === "string" && ATOM_TYPE_TO_DATASET[t].length > 0,
      `atom type '${t}' missing routing entry`,
    );
  }
});

test("ATOM_TYPE_TO_DATASET: self-improvement-lesson routes to self_improvement", () => {
  assert.equal(ATOM_TYPE_TO_DATASET["self-improvement-lesson"], "self_improvement");
});

test("ATOM_TYPE_TO_DATASET: knowledge-family routes to knowledge", () => {
  for (const t of ["decision", "bug-root-cause", "feedback-rule", "project-lore", "reference", "pattern-gotcha"]) {
    assert.equal(ATOM_TYPE_TO_DATASET[t], "knowledge", `${t} should route to knowledge`);
  }
});

test("routeAtomToDataset: returns mapped slot", () => {
  assert.equal(routeAtomToDataset("decision", "fallback"), "knowledge");
  assert.equal(routeAtomToDataset("self-improvement-lesson", "fallback"), "self_improvement");
});

test("routeAtomToDataset: fallback when type unknown", () => {
  assert.equal(routeAtomToDataset("brand-new-type", "knowledge"), "knowledge");
  assert.equal(routeAtomToDataset(undefined, "daily"), "daily");
  assert.equal(routeAtomToDataset(null, "x"), "x");
  // No fallback supplied -> undefined.
  assert.equal(routeAtomToDataset("nope"), undefined);
});

test("metadataForDify: always emits atom_type", () => {
  const out = metadataForDify({ type: "decision" });
  assert.deepEqual(out, { atom_type: "decision" });
});

test("metadataForDify: omits empty optional fields", () => {
  const out = metadataForDify({
    type: "decision",
    metadata: { project_module: "", language: "  ", task_type: undefined, error_pattern: null },
  });
  assert.deepEqual(out, { atom_type: "decision" });
});

test("metadataForDify: keeps populated optional fields, trimmed", () => {
  const out = metadataForDify({
    type: "bug-root-cause",
    metadata: {
      project_module: "  api  ",
      language: "javascript",
      task_type: "debugging",
      error_pattern: "503",
    },
  });
  assert.deepEqual(out, {
    atom_type: "bug-root-cause",
    project_module: "api",
    language: "javascript",
    task_type: "debugging",
    error_pattern: "503",
  });
});

test("metadataForDify: tags array joined with commas", () => {
  const out = metadataForDify({
    type: "decision",
    tags: ["alpha", " beta ", "", "gamma"],
  });
  assert.equal(out.tags, "alpha,beta,gamma");
});

test("metadataForDify: tags from metadata.tags string when no top-level array", () => {
  const out = metadataForDify({
    type: "decision",
    metadata: { tags: "  one,two  " },
  });
  assert.equal(out.tags, "one,two");
});

test("metadataForDify: empty/missing tags omits field", () => {
  const out1 = metadataForDify({ type: "decision", tags: [] });
  assert.equal("tags" in out1, false);
  const out2 = metadataForDify({ type: "decision", tags: ["", "  "] });
  assert.equal("tags" in out2, false);
  const out3 = metadataForDify({ type: "decision", metadata: { tags: "" } });
  assert.equal("tags" in out3, false);
});

test("metadataForDify: handles missing/garbage atom gracefully", () => {
  assert.deepEqual(metadataForDify(null), { atom_type: "" });
  assert.deepEqual(metadataForDify(undefined), { atom_type: "" });
  assert.deepEqual(metadataForDify({}), { atom_type: "" });
  assert.deepEqual(metadataForDify({ type: "  reference  " }), { atom_type: "reference" });
});

test("METADATA_SCHEMA matches mcp-server/src/schema.js PER_DOC_METADATA_FIELDS verbatim", () => {
  // The schema list is duplicated across runtimes (boilerplate scripts
  // import scripts/lib/datasets.mjs; the bridge module imports
  // mcp-server/src/schema.js: a separate Node module without import
  // access to scripts/lib/). The two sources MUST stay in lock-step or
  // create_dataset will install a different schema than dify-setup.sh
  // does. Direct imports both ends; deepEqual locks order + names.
  const hostFields = METADATA_SCHEMA.map((f) => f.name);
  assert.deepEqual(
    PER_DOC_METADATA_FIELDS,
    hostFields,
    `drift between scripts/lib/datasets.mjs:METADATA_SCHEMA and mcp-server/src/schema.js:PER_DOC_METADATA_FIELDS: both must list the same fields in the same order`,
  );
});

test("ATOM_TYPES cross-runtime parity: host scripts/lib/datasets.mjs == bridge mcp-server/src/schema.js", () => {
  // Round-33 added `plan` to host ATOM_TYPES and ATOM_TYPE_TO_DATASET.
  // Round-34 audited and found the bridge had no registry at all; it
  // hardcoded specific atom_type literals at four call sites in
  // mcp-server/src/index.js. Now both ends import from a shared module
  // (host imports from datasets.mjs, bridge imports from schema.js)
  // with this test locking the contract.
  //
  // ATOM_TYPES on host is a Set; bridge is an Array (ordered for the
  // shared-module ergonomics). Convert host to Array and compare as
  // sets (order-insensitive) so a future reorder isn't a false alarm.
  const hostArray = Array.from(ATOM_TYPES);
  assert.deepEqual(
    [...BRIDGE_ATOM_TYPES].sort(),
    hostArray.sort(),
    `drift between scripts/lib/datasets.mjs:ATOM_TYPES and mcp-server/src/schema.js:ATOM_TYPES: both must contain the same atom type names`,
  );
});

test("LESSON_ATOM_TYPE: matches the lesson type the host extractor produces", () => {
  // recall_lessons + save_lesson both key on this string. If a future
  // change renames the lesson type host-side ("self-improvement-lesson"
  // -> "lesson", say) without updating the bridge constant, the MCP
  // tool would write lessons no future recall could find. Lock it.
  assert.ok(ATOM_TYPES.has(LESSON_ATOM_TYPE), `LESSON_ATOM_TYPE '${LESSON_ATOM_TYPE}' must be in host ATOM_TYPES`);
  assert.equal(LESSON_ATOM_TYPE, "self-improvement-lesson");
});

test("KNOWLEDGE_CROSSREF_ATOM_TYPES: subset of host ATOM_TYPES, members route to knowledge slot", () => {
  // recall_lessons' includeKnowledge companion pass surfaces these
  // types from `knowledge`. Lock the contract that each entry routes
  // there per the host's ATOM_TYPE_TO_DATASET table.
  for (const t of KNOWLEDGE_CROSSREF_ATOM_TYPES) {
    assert.ok(ATOM_TYPES.has(t), `KNOWLEDGE_CROSSREF_ATOM_TYPES entry '${t}' must be in ATOM_TYPES`);
    assert.equal(ATOM_TYPE_TO_DATASET[t], "knowledge", `${t} should route to knowledge slot`);
  }
});

test("METADATA_SCHEMA: every field type is a valid Dify type", () => {
  // Dify supports only string / number / time per-doc metadata types. Every
  // field today (including the consolidate/recall set) is `string` (ISO
  // timestamps + numeric-string count, parsed client-side). Lock the allowed
  // set so a typo'd type ("datetime", "int") is caught before it reaches
  // create_dataset / dify-setup.sh (which would install a field Dify rejects).
  const VALID = new Set(["string", "number", "time"]);
  for (const field of METADATA_SCHEMA) {
    assert.ok(
      VALID.has(field.type),
      `METADATA_SCHEMA field '${field.name}' has type='${field.type}'; expected one of string|number|time`,
    );
  }
});

test("METADATA_SCHEMA cross-runtime TYPE parity: datasets.mjs == schema.js (name + type, in order)", () => {
  // The name-parity test above locks the field names. This locks the TYPES
  // too: create_dataset (bridge, PER_DOC_METADATA_SCHEMA) and dify-setup.sh
  // must install the SAME type for each field, or a doc's metadata write for
  // a time/number field silently no-ops against a string-typed field.
  assert.deepEqual(
    PER_DOC_METADATA_SCHEMA,
    METADATA_SCHEMA,
    "drift between mcp-server/src/schema.js:PER_DOC_METADATA_SCHEMA and scripts/lib/datasets.mjs:METADATA_SCHEMA: both must list the same {name,type} entries in the same order",
  );
});

test("dify-setup.sh SCHEMA_FIELDS is the THIRD source and stays in lock-step with the JS schema", () => {
  // The bash array is the shell installer's copy of the field list. Comments in
  // all three files claim it is parity-locked by this test, but nothing read the
  // shell file until now. Parse the SCHEMA_FIELDS=( ... ) array (multi-line, with
  // backslash continuations) and assert its names == METADATA_SCHEMA names, in
  // order, so a field added to the JS schema but forgotten in dify-setup.sh fails.
  const sh = fs.readFileSync(new URL("../scripts/dify-setup.sh", import.meta.url), "utf8");
  const m = sh.match(/SCHEMA_FIELDS=\(([\s\S]*?)\)/);
  assert.ok(m, "could not find SCHEMA_FIELDS=( ... ) in scripts/dify-setup.sh");
  const shellFields = m[1]
    .replace(/\\\s*\n/g, " ") // join backslash line-continuations
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(
    shellFields,
    METADATA_SCHEMA.map((f) => f.name),
    "drift between scripts/dify-setup.sh:SCHEMA_FIELDS and scripts/lib/datasets.mjs:METADATA_SCHEMA: the shell installer must list the same fields in the same order",
  );
});

test("METADATA_SCHEMA: consolidate/recall fields present with expected types", () => {
  const byName = Object.fromEntries(METADATA_SCHEMA.map((f) => [f.name, f.type]));
  const expected = {
    last_recalled_at: "string",
    recall_count: "string",
    superseded_by: "string",
    consolidated_at: "string",
    stale: "string",
    last_refreshed_at: "string",
    consolidate_truncated_at: "string",
  };
  for (const [name, type] of Object.entries(expected)) {
    assert.equal(byName[name], type, `field '${name}' should be type='${type}'`);
  }
});
