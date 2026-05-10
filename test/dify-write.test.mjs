// Lock the buildSaveFlags contract used by saveDocument(). The full
// saveDocument call spawns docker exec, which can't be tested without
// Docker; the flag-builder is the central wiring step (everything that
// matters for whether metadata reaches the bridge correctly), so we
// extract and test it directly.
//
// A regression here would silently downgrade plan-capture: an erroneous
// "{}" or "undefined" --metadata flag would land the doc in Dify with
// no atom_type=plan, and recall_lessons / search_memory filters would
// never find it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSaveFlags } from "../scripts/lib/dify-write.mjs";

test("buildSaveFlags: name + datasetId always present", () => {
  const f = buildSaveFlags({ name: "plan-foo.md", datasetId: "plans" });
  assert.equal(f.name, "plan-foo.md");
  assert.equal(f.datasetId, "plans");
});

test("buildSaveFlags: missing metadata -> --metadata flag is OMITTED", () => {
  for (const md of [undefined, null]) {
    const f = buildSaveFlags({ name: "x", datasetId: "y", metadata: md });
    assert.equal(f.metadata, undefined, `metadata=${md} must omit the flag`);
    assert.ok(!("metadata" in f), `metadata=${md} must not even be a key`);
  }
});

test("buildSaveFlags: empty-object metadata -> flag OMITTED", () => {
  const f = buildSaveFlags({ name: "x", datasetId: "y", metadata: {} });
  assert.ok(!("metadata" in f));
});

test("buildSaveFlags: non-object metadata (string/number/bool) -> flag OMITTED", () => {
  for (const md of ["literal", 42, true]) {
    const f = buildSaveFlags({ name: "x", datasetId: "y", metadata: md });
    assert.ok(!("metadata" in f), `metadata=${md} (${typeof md}) must omit the flag`);
  }
});

test("buildSaveFlags: normal metadata -> JSON-encoded once", () => {
  const md = { atom_type: "plan", task_type: "planning" };
  const f = buildSaveFlags({ name: "x", datasetId: "y", metadata: md });
  assert.equal(f.metadata, '{"atom_type":"plan","task_type":"planning"}');
  // Round-trip must produce the original object (no double-encoding).
  assert.deepEqual(JSON.parse(f.metadata), md);
});

test("buildSaveFlags: metadata containing quotes / backslashes / newlines round-trips", () => {
  const md = {
    atom_type: 'has "quote"',
    note: "back\\slash",
    multi: "line1\nline2",
  };
  const f = buildSaveFlags({ name: "x", datasetId: "y", metadata: md });
  // The flag must be valid JSON and decode back to the same object.
  assert.deepEqual(JSON.parse(f.metadata), md);
});

test("buildSaveFlags: empty datasetId / empty name pass through unchanged (caller validates)", () => {
  // execCli filters out undefined/null/"" flags, so passing "" here is
  // effectively the same as omitting; but the helper itself doesn't
  // pre-validate. Locks the contract that the helper is dumb wrt these
  // values and the bridge / execCli enforces required-ness.
  const f = buildSaveFlags({ name: "", datasetId: "", metadata: { a: "b" } });
  assert.equal(f.name, "");
  assert.equal(f.datasetId, "");
  assert.equal(f.metadata, '{"a":"b"}');
});
