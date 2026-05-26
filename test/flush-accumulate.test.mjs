// Unit tests for the pure per-day accumulation merge in flush.mjs.
// The day's daily-<date>.md doc accumulates every session by appending; the
// first write of the day has no prior content and is returned verbatim.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeDailyText } from "../scripts/hooks/flush.mjs";

test("first session of the day: returned verbatim", () => {
  assert.equal(mergeDailyText("", "block-A"), "block-A");
  assert.equal(mergeDailyText(null, "block-A"), "block-A");
  assert.equal(mergeDailyText("   \n  ", "block-A"), "block-A");
});

test("subsequent sessions append after a blank-line separator", () => {
  assert.equal(mergeDailyText("block-A", "block-B"), "block-A\n\nblock-B");
});

test("accumulates across three sessions", () => {
  let doc = mergeDailyText("", "s1");
  doc = mergeDailyText(doc, "s2");
  doc = mergeDailyText(doc, "s3");
  assert.equal(doc, "s1\n\ns2\n\ns3");
});

test("trailing whitespace on existing content is trimmed before joining", () => {
  assert.equal(mergeDailyText("block-A\n\n", "block-B"), "block-A\n\nblock-B");
});

test("both blocks' Atom markers survive concatenation (compile can parse all)", () => {
  const a = "# Daily flush session-end\n\n### Atom · decision · one\n- body: x\n";
  const b = "# Daily flush pre-compact\n\n### Atom · reference · two\n- body: y\n";
  const merged = mergeDailyText(a, b);
  const atomCount = (merged.match(/^### Atom /gm) || []).length;
  assert.equal(atomCount, 2);
});
