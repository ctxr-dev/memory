// Lock parseAtomsFromMarkdown's round-trip behaviour with flush.mjs's
// renderDailyDocument: a daily produced by flush MUST be parseable back
// into the same atoms. The two halves of the contract live in different
// files and could drift silently — these tests catch that.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAtomsFromMarkdown, forcedLessonUpdate, scoreAtomQuality } from "../scripts/compile.mjs";

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

// ---------- forcedLessonUpdate ----------

test("forcedLessonUpdate: same error_pattern returns deterministic update decision", () => {
  // Locked: compileFilters pre-filters candidates by error_pattern
  // server-side, so any returned candidate IS a same-pattern match. The
  // dedup contract requires lessons converge into one canonical doc per
  // error pattern — the LLM is bypassed for this case.
  const atom = {
    type: "self-improvement-lesson",
    title: "Always check token before commit",
    body: "Check token before commit. Why: prior incidents. How to apply: verify on every push.",
    tags: ["pr-loop"],
    metadata: { project_module: "auth", task_type: "review", error_pattern: "missing-token-check" },
  };
  const candidates = [{ documentId: "doc-existing-1", documentName: "lesson-foo.md", score: 0.81 }];
  const decision = forcedLessonUpdate(atom, candidates);
  assert.equal(decision.action, "update");
  assert.equal(decision.supersedes, "doc-existing-1");
  assert.equal(decision.merged_text, atom.body);
  assert.equal(decision.merged_name, atom.title);
  assert.ok(decision.reason.includes("missing-token-check"));
});

test("forcedLessonUpdate: returns null for non-lesson atom (LLM path)", () => {
  const atom = {
    type: "bug-root-cause",
    title: "x",
    body: "y",
    metadata: { error_pattern: "any" },
  };
  assert.equal(forcedLessonUpdate(atom, [{ documentId: "doc1" }]), null);
});

test("forcedLessonUpdate: returns null when atom has no error_pattern", () => {
  const atom = { type: "self-improvement-lesson", title: "x", body: "y", metadata: {} };
  assert.equal(forcedLessonUpdate(atom, [{ documentId: "doc1" }]), null);
});

test("forcedLessonUpdate: returns null for null / non-object atom (defensive)", () => {
  // Defensive guard added in round-38: callers may pass through bad
  // shapes (e.g. a bug in parseAtomsFromMarkdown produces null). Should
  // not throw; just fall through to LLM decideAction or the caller's
  // null-handling path.
  assert.equal(forcedLessonUpdate(null, [{ documentId: "x" }]), null);
  assert.equal(forcedLessonUpdate(undefined, [{ documentId: "x" }]), null);
  assert.equal(forcedLessonUpdate("not-an-object", [{ documentId: "x" }]), null);
  assert.equal(forcedLessonUpdate(42, [{ documentId: "x" }]), null);
});

test("forcedLessonUpdate: returns null when no candidates (LLM falls through to create)", () => {
  const atom = {
    type: "self-improvement-lesson",
    title: "x",
    body: "y",
    metadata: { error_pattern: "p" },
  };
  assert.equal(forcedLessonUpdate(atom, []), null);
  assert.equal(forcedLessonUpdate(atom, null), null);
});

// ---------- scoreAtomQuality ----------

function baseGoodAtom(overrides = {}) {
  return {
    type: "decision",
    title: "Pick X over Y",
    body: [
      "Use X over Y for the cache layer.",
      "Why: Y silently drops batched writes under sustained load.",
      "How to apply: every new service plugs X by default; override only with sign-off.",
    ].join("\n"),
    tags: ["arch", "cache"],
    metadata: { project_module: "infra" },
    ...overrides,
  };
}

test("scoreAtomQuality: a well-formed atom passes the rubric", () => {
  const r = scoreAtomQuality(baseGoodAtom());
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test("scoreAtomQuality: body < 80 chars flagged", () => {
  const r = scoreAtomQuality(baseGoodAtom({ body: "Too short." }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes("body too short")));
});

test("scoreAtomQuality: missing tags flagged", () => {
  const r = scoreAtomQuality(baseGoodAtom({ tags: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes("no tags")));
});

test("scoreAtomQuality: no evidence and no Why/How-to-apply lines flagged", () => {
  const r = scoreAtomQuality(baseGoodAtom({
    body: "A long body explaining the decision in narrative form, but no structured sections at all whatsoever.",
  }));
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes("'Why:'")));
});

test("scoreAtomQuality: evidence alone satisfies the why/how-to rule", () => {
  const r = scoreAtomQuality(baseGoodAtom({
    body: "A long body in narrative form without structured sections at all whatsoever today.",
    evidence: "https://prior-incident.example/url",
  }));
  assert.equal(r.ok, true);
});

test("scoreAtomQuality: self-improvement-lesson without project_module flagged", () => {
  const r = scoreAtomQuality({
    type: "self-improvement-lesson",
    title: "Always verify",
    body: "Always verify the token before commit. Why: prior incidents. How to apply: every push.",
    tags: ["x"],
    metadata: { task_type: "review", error_pattern: "no-token-check" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes("project_module")));
});

test("scoreAtomQuality: bug-root-cause without project_module flagged", () => {
  const r = scoreAtomQuality({
    type: "bug-root-cause",
    title: "Stale cache",
    body: "Cache stayed pre-migrate. Why: TTL longer than migration. How to apply: flush after migrate.",
    tags: ["db"],
    metadata: { error_pattern: "stale-cache" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((s) => s.includes("project_module")));
});

test("scoreAtomQuality: missing inputs default to non-ok", () => {
  const r = scoreAtomQuality(null);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.length >= 1);
});

test("forcedLessonUpdate: returns null when top candidate has no documentId", () => {
  const atom = {
    type: "self-improvement-lesson",
    title: "x",
    body: "y",
    metadata: { error_pattern: "p" },
  };
  assert.equal(forcedLessonUpdate(atom, [{}]), null);
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
