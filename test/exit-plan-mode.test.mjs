// Pure-function tests for the ExitPlanMode -> RAG plan-capture hook.
//
// We test planDocSpec + extractTitle directly. The CLI driver in
// scripts/hooks/exit-plan-mode.mjs is a thin wrapper around these +
// saveDocument(); the helpers in dify-write.mjs are covered by the
// existing dify-pure / merge-config / etc. test suites and a real
// bridge call would require Docker.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planDocSpec, extractTitle } from "../scripts/hooks/exit-plan-mode.mjs";

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
