// Pure-function tests for the ExitPlanMode -> RAG plan-capture hook.
//
// We test planDocSpec + extractTitle directly. The CLI driver in
// scripts/hooks/exit-plan-mode.mjs is a thin wrapper around these +
// saveDocument(); the helpers in dify-write.mjs are covered by the
// existing dify-pure / merge-config / etc. test suites and a real
// bridge call would require Docker.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planDocSpec, extractTitle, fencePlanBody } from "../scripts/hooks/exit-plan-mode.mjs";

test("extractTitle: H1 wins when present", () => {
  assert.equal(extractTitle("# Foo Bar\n\nbody"), "Foo Bar");
  assert.equal(extractTitle("# Round-21: ship the hook\n\nmore"), "Round-21: ship the hook");
  // Indented H1 is NOT a real H1 (markdown spec); falls through to first line.
  assert.equal(extractTitle("    # not a heading\n\nreal first line"), "# not a heading");
});

test("extractTitle: falls back to first non-empty line, capped at 80 chars", () => {
  assert.equal(extractTitle("first line text\n\nmore"), "first line text");
  assert.equal(extractTitle("\n\n  spaced  \n\nmore"), "spaced");
  const long = "x".repeat(120);
  assert.equal(extractTitle(long), "x".repeat(80));
});

test("extractTitle: empty / whitespace / null", () => {
  assert.equal(extractTitle(""), "untitled");
  assert.equal(extractTitle("   \n  \n"), "untitled");
  assert.equal(extractTitle(null), "untitled");
  assert.equal(extractTitle(undefined), "untitled");
});

test("planDocSpec: approved + H1 -> plan-<slug>.md", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# Foo Bar\n\nbody content here" },
  });
  assert.equal(spec.skip, undefined);
  assert.equal(spec.name, "plan-foo-bar.md");
  assert.equal(spec.datasetSlot, "plans");
  assert.match(spec.text, /body content here/);
  assert.deepEqual(spec.metadata, {
    atom_type: "plan",
    task_type: "planning",
  });
  // project_module is intentionally omitted so it doesn't pollute filters.
  assert.ok(!("project_module" in spec.metadata));
});

test("planDocSpec: approved + no H1 -> first-line slug", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "first line text\n\nrest of plan" },
  });
  assert.equal(spec.name, "plan-first-line-text.md");
});

test("planDocSpec: approved + empty plan -> skip(empty-plan)", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "   \n   " },
  });
  assert.equal(spec.skip, "empty-plan");
  assert.equal(spec.name, undefined);
});

test("planDocSpec: missing plan field -> skip(empty-plan)", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: {},
  });
  assert.equal(spec.skip, "empty-plan");
});

test("planDocSpec: approved=false -> skip(not-approved)", () => {
  const spec = planDocSpec({
    tool_response: { approved: false },
    tool_input: { plan: "# Whatever" },
  });
  assert.equal(spec.skip, "not-approved");
});

test("planDocSpec: approved=null -> skip(not-approved)", () => {
  const spec = planDocSpec({
    tool_response: { approved: null },
    tool_input: { plan: "# Whatever" },
  });
  assert.equal(spec.skip, "not-approved");
});

test("planDocSpec: missing tool_response -> skip(not-approved)", () => {
  const spec = planDocSpec({ tool_input: { plan: "# Whatever" } });
  assert.equal(spec.skip, "not-approved");
});

test("planDocSpec: missing tool_input -> skip(not-approved before empty-plan)", () => {
  // The approval gate runs first. With no tool_response we get not-approved
  // even though tool_input would also be empty.
  const spec = planDocSpec({});
  assert.equal(spec.skip, "not-approved");
});

test("planDocSpec: idempotent slug across re-iterations", () => {
  const a = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# Round-21: ship the hook\n\nfirst pass" },
  });
  const b = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# Round-21: ship the hook\n\nrevised pass" },
  });
  assert.equal(a.name, b.name);
  assert.notEqual(a.text, b.text);
});

test("planDocSpec: long title slug truncated to 60 chars (slugify contract)", () => {
  const longTitle = "A".repeat(200);
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: `# ${longTitle}\n\nbody` },
  });
  // name = "plan-" + slug + ".md"; slug must be <= 60 chars per slugify default.
  const slug = spec.name.replace(/^plan-/, "").replace(/\.md$/, "");
  assert.ok(slug.length <= 60, `slug length ${slug.length} > 60: ${slug}`);
});

test("planDocSpec: title with punctuation slugified to kebab-case", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# Hello, World! (v2)\n\nbody" },
  });
  assert.equal(spec.name, "plan-hello-world-v2.md");
});

// ---- extractTitle edge cases ----

test("extractTitle: multiple H1s — first wins", () => {
  assert.equal(extractTitle("# First\n\nbody\n\n# Second"), "First");
});

test("extractTitle: H1 after preamble lines is still picked up (regex is /m)", () => {
  assert.equal(extractTitle("preamble line\n\n# Real Title\n\nbody"), "Real Title");
});

test("extractTitle: CRLF line endings (Windows clipboard)", () => {
  assert.equal(extractTitle("# CRLF Title\r\n\r\nbody"), "CRLF Title");
});

test("extractTitle: H2 only (no H1) falls through to first non-empty line verbatim", () => {
  // The regex requires ONE leading hash; "## Foo" doesn't match. Falls
  // through to first-line "## Foo" — slugify will strip the hashes, so
  // the eventual doc name is plan-foo.md. Lock current behaviour.
  assert.equal(extractTitle("## Foo\n\nbody"), "## Foo");
});

test("extractTitle: H1 with markdown emphasis is captured verbatim (slugify drops the asterisks)", () => {
  // Documenting the literal capture; slug correctness is asserted in the
  // planDocSpec test below.
  assert.equal(extractTitle("# **Bold** title"), "**Bold** title");
});

test("planDocSpec: H1 with emphasis -> slug strips emphasis", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# **Bold** title\n\nbody" },
  });
  assert.equal(spec.name, "plan-bold-title.md");
});

// ---- planDocSpec input-shape edge cases ----

test("planDocSpec: non-string plan (object) -> skip(non-string-plan), no string coercion garbage", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: { not: "a string" } },
  });
  assert.equal(spec.skip, "non-string-plan");
});

test("planDocSpec: non-string plan (number) -> skip(non-string-plan)", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: 42 },
  });
  assert.equal(spec.skip, "non-string-plan");
});

test("planDocSpec: non-string plan (boolean) -> skip(non-string-plan)", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: true },
  });
  assert.equal(spec.skip, "non-string-plan");
});

test("planDocSpec: tool_response.approved === 1 (truthy but not strict-true) -> skip(not-approved)", () => {
  const spec = planDocSpec({
    tool_response: { approved: 1 },
    tool_input: { plan: "# Whatever" },
  });
  assert.equal(spec.skip, "not-approved");
});

test("planDocSpec: tool_response.approved === 'true' (string) -> skip(not-approved)", () => {
  const spec = planDocSpec({
    tool_response: { approved: "true" },
    tool_input: { plan: "# Whatever" },
  });
  assert.equal(spec.skip, "not-approved");
});

test("planDocSpec: hookInput is null -> skip(not-approved) without throwing", () => {
  const spec = planDocSpec(null);
  assert.equal(spec.skip, "not-approved");
});

test("planDocSpec: hookInput is undefined -> skip(not-approved) without throwing", () => {
  const spec = planDocSpec(undefined);
  assert.equal(spec.skip, "not-approved");
});

// ---- redaction parity with flush.mjs ----

test("planDocSpec: secrets in plan body are redacted before persistence", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# Auth plan\n\nUse the key sk-aBcDeFgHiJkLmNoPqRsTuV12 to call the API." },
  });
  assert.equal(spec.name, "plan-auth-plan.md");
  assert.match(spec.text, /\[REDACTED|REDACTED\]/, "redact() must rewrite the secret");
  assert.doesNotMatch(spec.text, /sk-aBcDeFgHiJkLmNoPqRsTuV12/, "raw secret must not survive");
});

test("planDocSpec: redact is idempotent (clean plan body survives fencing intact)", () => {
  const clean = "# Clean plan\n\n1. Step one.\n2. Step two.";
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: clean },
  });
  // The fence wraps the body but doesn't mutate it; the original text is
  // present verbatim between the BEGIN/END markers.
  assert.match(spec.text, /BEGIN UNTRUSTED PLAN BODY/);
  assert.match(spec.text, /END UNTRUSTED PLAN BODY/);
  assert.ok(spec.text.includes(clean), "clean body must appear verbatim inside the fence");
});

// ---- untrusted-content fence ----

test("fencePlanBody: wraps text in BEGIN/END markers with origin attribution", () => {
  const wrapped = fencePlanBody("hello");
  assert.match(wrapped, /BEGIN UNTRUSTED PLAN BODY \(origin: ExitPlanMode hook/);
  assert.match(wrapped, /END UNTRUSTED PLAN BODY/);
  assert.ok(wrapped.includes("hello"));
});

test("planDocSpec: spec.text is fenced so future agents see data-not-instructions", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# Lock plan\n\nbody" },
  });
  assert.match(spec.text, /<!-- BEGIN UNTRUSTED PLAN BODY/);
  assert.match(spec.text, /<!-- END UNTRUSTED PLAN BODY -->$/);
});

// ---- size cap ----

test("planDocSpec: oversized plan -> skip(plan-too-large)", () => {
  // Default cap is 256_000 bytes; pass an explicit small cap to test
  // the gate without allocating 256KB strings.
  const spec = planDocSpec(
    {
      tool_response: { approved: true },
      tool_input: { plan: "# Title\n\n" + "x".repeat(2000) },
    },
    { maxBytes: 500 },
  );
  assert.equal(spec.skip?.startsWith("plan-too-large"), true, `got: ${spec.skip}`);
});

test("planDocSpec: under-cap plan -> success", () => {
  const spec = planDocSpec(
    {
      tool_response: { approved: true },
      tool_input: { plan: "# Title\n\nshort body" },
    },
    { maxBytes: 1000 },
  );
  assert.equal(spec.skip, undefined);
  assert.equal(spec.name, "plan-title.md");
});

// ---- regression lock: metadata stays minimal ----

test("planDocSpec: metadata has exactly atom_type + task_type, no other keys", () => {
  const spec = planDocSpec({
    tool_response: { approved: true },
    tool_input: { plan: "# Lock plan\n\nbody" },
  });
  assert.equal(Object.keys(spec.metadata).length, 2);
  assert.equal(spec.metadata.atom_type, "plan");
  assert.equal(spec.metadata.task_type, "planning");
});
