// Lock the PURE consolidate analysis core: dedup grouping, keeper selection,
// staleness verdicts, and the no-LLM archive policy (exact/lesson-key
// archivable, fuzzy similarity flag-only). No I/O, no LLM — all deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SOURCE_PASSES,
  DETERMINISTIC_ARCHIVE_PASSES,
  contentHash,
  lessonKey,
  pickKeeper,
  sha256Pairs,
  lessonKeyPairs,
  similarityPairs,
  dedupePairs,
  partitionByArchivePolicy,
  lastActivityMs,
  isStale,
  staleCandidates,
  compressCandidates,
} from "../mcp-server/src/consolidate-core.js";

const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30.4375 * DAY;
const NOW = 1_700_000_000_000; // fixed clock

function leaf(over = {}) {
  return {
    documentId: over.documentId || "k",
    name: over.name || "doc.md",
    category: over.category || "knowledge",
    createdAtMs: over.createdAtMs ?? NOW,
    enabled: over.enabled ?? true,
    metadata: over.metadata || {},
    body: over.body,
  };
}

test("contentHash: stable + body-sensitive", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
});

test("lessonKey: project_module|task_type|error_pattern, empty error_pattern -> ''", () => {
  assert.equal(
    lessonKey(leaf({ metadata: { error_pattern: "Bad-ID", project_module: "API", task_type: "Debug" } })),
    "api|debug|bad-id",
  );
  assert.equal(lessonKey(leaf({ metadata: { project_module: "api" } })), "");
  // Partial identity must NOT produce a key (would collapse unrelated lessons).
  assert.equal(lessonKey(leaf({ metadata: { error_pattern: "flaky", project_module: "api" } })), "", "missing task_type -> no key");
  assert.equal(lessonKey(leaf({ metadata: { error_pattern: "flaky", task_type: "debug" } })), "", "missing project_module -> no key");
});

test("pickKeeper: newest createdAtMs wins; tiebreak lex documentId", () => {
  const a = leaf({ documentId: "a", createdAtMs: NOW });
  const b = leaf({ documentId: "b", createdAtMs: NOW + 1000 });
  assert.equal(pickKeeper(a, b).documentId, "b");
  const c = leaf({ documentId: "c", createdAtMs: NOW });
  const d = leaf({ documentId: "d", createdAtMs: NOW });
  assert.equal(pickKeeper(c, d).documentId, "c"); // lex tiebreak
});

test("sha256Pairs: identical bodies group; keeper newest, losers paired", () => {
  const leaves = [
    leaf({ documentId: "old", body: "same body", createdAtMs: NOW }),
    leaf({ documentId: "new", body: "same body", createdAtMs: NOW + 5000 }),
    leaf({ documentId: "other", body: "different", createdAtMs: NOW }),
  ];
  const pairs = sha256Pairs(leaves);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].keeper.documentId, "new");
  assert.equal(pairs[0].loser.documentId, "old");
  assert.equal(pairs[0].sourcePass, SOURCE_PASSES.SHA256);
});

test("sha256Pairs: leaves without a body are skipped", () => {
  const pairs = sha256Pairs([leaf({ documentId: "a" }), leaf({ documentId: "b" })]);
  assert.equal(pairs.length, 0);
});

test("lessonKeyPairs: same key only for self-improvement-lesson", () => {
  const md = (ep) => ({ atom_type: "self-improvement-lesson", error_pattern: ep, project_module: "api", task_type: "debug" });
  const leaves = [
    leaf({ documentId: "l1", metadata: md("flaky"), createdAtMs: NOW }),
    leaf({ documentId: "l2", metadata: md("flaky"), createdAtMs: NOW + 1000 }),
    leaf({ documentId: "l3", metadata: md("other"), createdAtMs: NOW }),
    // a knowledge atom with the same fields is NOT lesson-key eligible
    leaf({ documentId: "k1", metadata: { atom_type: "bug-root-cause", error_pattern: "flaky", project_module: "api", task_type: "debug" } }),
  ];
  const pairs = lessonKeyPairs(leaves);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].keeper.documentId, "l2");
  assert.equal(pairs[0].loser.documentId, "l1");
});

test("similarityPairs: above-threshold candidates pair; self excluded", () => {
  const q = leaf({ documentId: "q", createdAtMs: NOW + 1000 });
  const cands = [
    { ...leaf({ documentId: "q", createdAtMs: NOW + 1000 }), score: 0.99 }, // self
    { ...leaf({ documentId: "a", createdAtMs: NOW }), score: 0.9 },
    { ...leaf({ documentId: "b", createdAtMs: NOW }), score: 0.5 }, // below
  ];
  const pairs = similarityPairs(q, cands, 0.88);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].loser.documentId, "a"); // q is newer -> keeper
  assert.equal(pairs[0].keeper.documentId, "q");
  assert.equal(pairs[0].sourcePass, SOURCE_PASSES.SIMILARITY);
});

test("dedupePairs: one pair per loser, highest-precedence sourcePass wins", () => {
  const keeper = leaf({ documentId: "keep", createdAtMs: NOW + 9999 });
  const loser = leaf({ documentId: "lose", createdAtMs: NOW });
  const pairs = [
    { keeper, loser, sourcePass: SOURCE_PASSES.SIMILARITY, score: 0.9 },
    { keeper, loser, sourcePass: SOURCE_PASSES.SHA256 },
  ];
  const out = dedupePairs(pairs);
  assert.equal(out.length, 1);
  assert.equal(out[0].sourcePass, SOURCE_PASSES.SHA256);
});

test("dedupePairs: drops a pair whose keeper is archived as a loser elsewhere", () => {
  // A is loser to B (sha256); A is keeper of C (similarity). The A-as-keeper
  // pair is dropped so we never rewrite A then archive it.
  const A = leaf({ documentId: "A", createdAtMs: NOW + 100 });
  const B = leaf({ documentId: "B", createdAtMs: NOW + 200 });
  const C = leaf({ documentId: "C", createdAtMs: NOW });
  const pairs = [
    { keeper: B, loser: A, sourcePass: SOURCE_PASSES.SHA256 },
    { keeper: A, loser: C, sourcePass: SOURCE_PASSES.SIMILARITY },
  ];
  const out = dedupePairs(pairs);
  assert.deepEqual(out.map((p) => p.loser.documentId), ["A"]);
});

test("partitionByArchivePolicy: sha256+lesson-key deterministic, similarity fuzzy", () => {
  const mk = (pass) => ({ keeper: leaf({ documentId: "k" }), loser: leaf({ documentId: `l-${pass}` }), sourcePass: pass });
  const { deterministic, fuzzy } = partitionByArchivePolicy([
    mk(SOURCE_PASSES.SHA256),
    mk(SOURCE_PASSES.LESSON_KEY),
    mk(SOURCE_PASSES.SIMILARITY),
  ]);
  assert.equal(deterministic.length, 2);
  assert.equal(fuzzy.length, 1);
  assert.equal(fuzzy[0].sourcePass, SOURCE_PASSES.SIMILARITY);
  assert.ok(DETERMINISTIC_ARCHIVE_PASSES.has(SOURCE_PASSES.SHA256));
  assert.ok(!DETERMINISTIC_ARCHIVE_PASSES.has(SOURCE_PASSES.SIMILARITY));
});

test("lastActivityMs: max(last_recalled_at, createdAt)", () => {
  const recalledIso = new Date(NOW).toISOString();
  const l = leaf({ createdAtMs: NOW - 10 * MONTH, metadata: { last_recalled_at: recalledIso } });
  assert.equal(lastActivityMs(l), NOW);
  const noRecall = leaf({ createdAtMs: NOW - 10 * MONTH });
  assert.equal(lastActivityMs(noRecall), NOW - 10 * MONTH);
});

test("isStale: old + never-recalled eligible atom is stale; recent recall overrides age", () => {
  const old = leaf({ metadata: { atom_type: "self-improvement-lesson" }, createdAtMs: NOW - 8 * MONTH });
  assert.equal(isStale(old, NOW, 6), true);

  const recalled = leaf({
    metadata: { atom_type: "self-improvement-lesson", last_recalled_at: new Date(NOW - 1 * MONTH).toISOString() },
    createdAtMs: NOW - 8 * MONTH,
  });
  assert.equal(isStale(recalled, NOW, 6), false); // recent recall keeps it fresh

  const ineligible = leaf({ metadata: { atom_type: "decision" }, createdAtMs: NOW - 24 * MONTH });
  assert.equal(isStale(ineligible, NOW, 6), false); // wrong atom_type
});

test("staleCandidates: filters to stale eligible leaves", () => {
  const leaves = [
    leaf({ documentId: "stale", metadata: { atom_type: "feedback-rule" }, createdAtMs: NOW - 9 * MONTH }),
    leaf({ documentId: "fresh", metadata: { atom_type: "feedback-rule" }, createdAtMs: NOW - 1 * MONTH }),
  ];
  const out = staleCandidates(leaves, NOW, 6);
  assert.deepEqual(out.map((l) => l.documentId), ["stale"]);
});

test("compressCandidates: disabled + oversized + aged + not-yet-truncated", () => {
  const big = "x".repeat(2000);
  const leaves = [
    leaf({ documentId: "c1", enabled: false, body: big, createdAtMs: NOW - 200 * DAY }),
    leaf({ documentId: "small", enabled: false, body: "short", createdAtMs: NOW - 200 * DAY }),
    leaf({ documentId: "recent", enabled: false, body: big, createdAtMs: NOW - 10 * DAY }),
    leaf({ documentId: "already", enabled: false, body: big, createdAtMs: NOW - 200 * DAY, metadata: { consolidate_truncated_at: "x" } }),
  ];
  const out = compressCandidates(leaves, NOW, { bodyMax: 1200, archiveAgeDays: 180 });
  assert.deepEqual(out.map((l) => l.documentId), ["c1"]);
});
