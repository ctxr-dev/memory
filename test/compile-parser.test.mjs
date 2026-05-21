// Lock parseAtomsFromMarkdown's round-trip behaviour with flush.mjs's
// renderDailyDocument: a daily produced by flush MUST be parseable back
// into the same atoms. The two halves of the contract live in different
// files and could drift silently — these tests catch that.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAtomsFromMarkdown } from "../scripts/compile.mjs";

function renderAtom({ type, title, tags = [], metadata = {}, body, evidence }) {
  const lines = [
    `### Atom · ${type} · ${title}`,
    `- type: ${type}`,
    `- title: ${title}`,
    `- tags: [${tags.join(", ")}]`,
    `- metadata: ${JSON.stringify(metadata)}`,
    `- body: |`,
    ...String(body).split(/\r?\n/).map((l) => `    ${l}`),
  ];
  if (evidence) lines.push(`- evidence: ${JSON.stringify(evidence)}`);
  return lines.join("\n");
}

test("parseAtomsFromMarkdown: single atom round-trip", () => {
  const md = renderAtom({
    type: "decision",
    title: "Use X over Y",
    tags: ["arch", "infra"],
    metadata: { project_module: "auth", language: "go", task_type: "planning" },
    body: "Use X over Y because Z.",
  });
  const atoms = parseAtomsFromMarkdown(md);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].type, "decision");
  assert.equal(atoms[0].title, "Use X over Y");
  assert.deepEqual(atoms[0].tags, ["arch", "infra"]);
  assert.equal(atoms[0].metadata.project_module, "auth");
  assert.equal(atoms[0].body, "Use X over Y because Z.");
});

test("parseAtomsFromMarkdown: multi-line evidence with embedded quotes round-trips", () => {
  // Regression: flush.mjs JSON.stringifies evidence so newlines and "
  // are escape-encoded into a single line. Parser must JSON.parse it
  // back into the original string. Failure mode: parser would either
  // return the raw JSON literal (with quotes) or drop the atom.
  const evidence = `Line 1 with "quote"\nLine 2\n  indented "more"`;
  const md = renderAtom({
    type: "bug-root-cause",
    title: "Stale cache after migrate",
    tags: ["db"],
    metadata: { project_module: "infra", error_pattern: "stale-cache-after-migrate" },
    body: "Migration applied but the cache held the pre-migrate schema.",
    evidence,
  });
  const atoms = parseAtomsFromMarkdown(md);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].evidence, evidence);
});

test("parseAtomsFromMarkdown: evidence with raw (non-JSON) value falls back to the trimmed literal", () => {
  // Hand-edited daily: someone wrote evidence as plain text without
  // JSON-encoding it. We don't want the atom dropped — fall back.
  const md = [
    "### Atom · decision · Pick the simpler approach",
    "- type: decision",
    "- title: Pick the simpler approach",
    "- tags: [arch]",
    "- metadata: {}",
    "- body: |",
    "    Use the simpler design.",
    "- evidence: raw text not json-encoded",
  ].join("\n");
  const atoms = parseAtomsFromMarkdown(md);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].evidence, "raw text not json-encoded");
});

test("parseAtomsFromMarkdown: evidence parsed JSON null/number is coerced to the raw literal", () => {
  // Edge case: evidence: null would JSON.parse to null. We don't want a
  // non-string evidence value leaking downstream — fall back to the raw.
  const md = [
    "### Atom · decision · Edge case",
    "- type: decision",
    "- title: Edge case",
    "- tags: [edge]",
    "- metadata: {}",
    "- body: |",
    "    Body text.",
    "- evidence: null",
  ].join("\n");
  const atoms = parseAtomsFromMarkdown(md);
  assert.equal(atoms.length, 1);
  assert.equal(atoms[0].evidence, "null");
});

test("parseAtomsFromMarkdown: metadata parsed non-object falls back to {}", () => {
  const md = [
    "### Atom · decision · Bogus metadata",
    "- type: decision",
    "- title: Bogus metadata",
    "- tags: [x]",
    "- metadata: [1, 2, 3]",
    "- body: |",
    "    Body text.",
  ].join("\n");
  const atoms = parseAtomsFromMarkdown(md);
  assert.equal(atoms.length, 1);
  assert.deepEqual(atoms[0].metadata, {});
});

test("parseAtomsFromMarkdown: unknown atom type is skipped", () => {
  const md = renderAtom({
    type: "made-up-type",
    title: "Should not be promoted",
    tags: ["x"],
    body: "Body",
  });
  const atoms = parseAtomsFromMarkdown(md);
  assert.equal(atoms.length, 0);
});

test("parseAtomsFromMarkdown: multiple atoms parse independently", () => {
  const md = [
    renderAtom({ type: "decision", title: "First", tags: ["a"], body: "Body 1" }),
    renderAtom({ type: "reference", title: "Second", tags: ["b"], body: "Body 2" }),
  ].join("\n");
  const atoms = parseAtomsFromMarkdown(md);
  assert.equal(atoms.length, 2);
  assert.equal(atoms[0].type, "decision");
  assert.equal(atoms[1].type, "reference");
});
