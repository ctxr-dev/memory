// Lock the atom-type registry, dataset routing table, and metadata
// normaliser. compile.mjs and flush.mjs both depend on these contracts; a
// silent change here would break promotion routing or downstream filters.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ATOM_TYPES,
  ATOM_TYPE_TO_DATASET,
  metadataForDify,
  routeAtomToDataset,
} from "../scripts/lib/datasets.mjs";

test("ATOM_TYPES: stable known set", () => {
  const expected = [
    "decision",
    "bug-root-cause",
    "feedback-rule",
    "project-lore",
    "reference",
    "pattern-gotcha",
    "self-improvement-lesson",
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
