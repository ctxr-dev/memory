// Verify scripts/lib/slug.mjs and mcp-server/src/slug.js produce identical
// output for the 5 shared functions (slugify, timestampUtc, dailyDocName,
// knowledgeDocName, lessonDocName) and that doc names round-trip cleanly
// through the parse helpers exposed by scripts/lib/slug.mjs.
//
// Round-2 audit history: a name-format bug broke save_lesson +
// parseLessonDocName roundtrip. These tests lock the contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as host from "../scripts/lib/slug.mjs";
import * as container from "../mcp-server/src/slug.js";

const FIXED_DATE = new Date(Date.UTC(2026, 4, 9, 13, 4, 5, 678)); // 2026-05-09T13:04:05.678Z

test("slugify: lowercase, ascii-fold, hyphenate", () => {
  for (const fn of [host.slugify, container.slugify]) {
    assert.equal(fn("Hello, World!"), "hello-world");
    assert.equal(fn("  multiple   spaces  "), "multiple-spaces");
    assert.equal(fn("CamelCase Title"), "camelcase-title");
    assert.equal(fn(""), "untitled");
    assert.equal(fn("!!!"), "untitled");
    assert.equal(fn(null), "untitled");
    assert.equal(fn(undefined), "untitled");
    assert.equal(fn("café"), "cafe");
    assert.equal(fn("naïve approach"), "naive-approach");
    // length cap default 60
    const long = fn("a".repeat(120));
    assert.ok(long.length <= 60, `slug length ${long.length} > 60`);
    // trailing hyphens after slice are trimmed
    assert.ok(!long.endsWith("-"), "trimmed trailing hyphens");
  }
});

test("slugify: maxLen override", () => {
  for (const fn of [host.slugify, container.slugify]) {
    assert.equal(fn("hello world", { maxLen: 5 }), "hello");
    assert.equal(fn("a-b-c-d-e", { maxLen: 4 }), "a-b");
  }
});

test("timestampUtc: deterministic format", () => {
  const a = host.timestampUtc(FIXED_DATE);
  const b = container.timestampUtc(FIXED_DATE);
  assert.equal(a, b);
  assert.equal(a, "2026-05-09-130405678");
});

test("dailyDocName: identical across runtimes", () => {
  assert.equal(host.dailyDocName(FIXED_DATE), container.dailyDocName(FIXED_DATE));
  assert.equal(host.dailyDocName(FIXED_DATE), "daily-2026-05-09-130405678.md");
});

test("knowledgeDocName: identical across runtimes", () => {
  for (const title of ["Hello World", "Bug Root Cause: 503", "café notes"]) {
    assert.equal(
      host.knowledgeDocName(title, FIXED_DATE),
      container.knowledgeDocName(title, FIXED_DATE),
      `mismatch for title=${title}`,
    );
  }
  assert.equal(
    host.knowledgeDocName("Hello World", FIXED_DATE),
    "knowledge-hello-world-2026-05-09-130405678.md",
  );
});

test("lessonDocName: identical across runtimes", () => {
  for (const title of ["Hello World", "Lesson #42 — debug!", ""]) {
    assert.equal(
      host.lessonDocName(title, FIXED_DATE),
      container.lessonDocName(title, FIXED_DATE),
      `mismatch for title=${title}`,
    );
  }
  assert.equal(
    host.lessonDocName("Hello World", FIXED_DATE),
    "lesson-hello-world-2026-05-09-130405678.md",
  );
});

test("parseDailyDocName: roundtrips dailyDocName output", () => {
  const name = host.dailyDocName(FIXED_DATE);
  const parsed = host.parseDailyDocName(name);
  assert.deepEqual(parsed, { date: "2026-05-09", time: "130405", ms: "678" });
});

test("parseKnowledgeDocName: roundtrips knowledgeDocName output", () => {
  for (const title of ["hello world", "Decision: use Dify", "weird----title"]) {
    const slug = host.slugify(title);
    const name = host.knowledgeDocName(title, FIXED_DATE);
    const parsed = host.parseKnowledgeDocName(name);
    assert.ok(parsed, `failed to parse ${name}`);
    assert.equal(parsed.slug, slug);
    assert.equal(parsed.date, "2026-05-09");
    assert.equal(parsed.time, "130405");
    assert.equal(parsed.ms, "678");
  }
});

test("parseLessonDocName: roundtrips lessonDocName output", () => {
  // The exact case the round-2 audit guarded against.
  for (const title of ["my lesson", "Lesson #42 — debug!", "self improvement"]) {
    const slug = host.slugify(title);
    const name = host.lessonDocName(title, FIXED_DATE);
    const parsed = host.parseLessonDocName(name);
    assert.ok(parsed, `failed to parse ${name}`);
    assert.equal(parsed.slug, slug);
    assert.equal(parsed.date, "2026-05-09");
    assert.equal(parsed.time, "130405");
    assert.equal(parsed.ms, "678");
  }
});

test("parse helpers: reject malformed names", () => {
  assert.equal(host.parseDailyDocName(""), null);
  assert.equal(host.parseDailyDocName("daily.md"), null);
  assert.equal(host.parseDailyDocName("daily-2026-05-09.md"), null);
  assert.equal(host.parseKnowledgeDocName("knowledge-no-timestamp.md"), null);
  assert.equal(host.parseLessonDocName("lesson-only-name.md"), null);
  assert.equal(host.parseLessonDocName(null), null);
});
