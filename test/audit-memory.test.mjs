// Lock the audit_memory finder helpers. The tool itself is registered
// inside mcp-server/src/index.js which top-level-instantiates an
// McpServer; we test the exported pure helpers directly so we don't
// have to spin up the bridge harness.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  indexDocMetadata,
  findStalePlans,
  findMissingMetadata,
  findStaleProjectLore,
  findDuplicateErrorPatternLessons,
} from "../mcp-server/src/audit.js";

function mkDoc({ id, name, createdAt, metadata = {} }) {
  return {
    id,
    name,
    created_at: createdAt,
    doc_metadata: Object.entries(metadata).map(([k, v]) => ({ id: k, name: k, value: v, type: "string" })),
  };
}

test("indexDocMetadata: flattens doc_metadata array into a key-value map", () => {
  const doc = mkDoc({
    id: "x",
    name: "y.md",
    createdAt: 0,
    metadata: { atom_type: "decision", project_module: "auth" },
  });
  const md = indexDocMetadata(doc);
  assert.deepEqual(md, { atom_type: "decision", project_module: "auth" });
});

test("indexDocMetadata: handles missing doc_metadata", () => {
  assert.deepEqual(indexDocMetadata({}), {});
  assert.deepEqual(indexDocMetadata({ doc_metadata: null }), {});
});

// ---------- findStalePlans ----------

test("findStalePlans: older slug that is a hyphen-delimited prefix of a newer slug is flagged", () => {
  const docs = [
    mkDoc({ id: "d1", name: "plan-auth.md", createdAt: 100 }),
    mkDoc({ id: "d2", name: "plan-auth-rewrite.md", createdAt: 200 }),
  ];
  const out = findStalePlans(docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].documentId, "d1");
  assert.equal(out[0].class, "stale-plans");
  assert.equal(out[0].suggested_action, "delete");
});

test("findStalePlans: same-name docs (upsert-by-name path) are NOT flagged", () => {
  const docs = [
    mkDoc({ id: "d1", name: "plan-auth.md", createdAt: 100 }),
    mkDoc({ id: "d2", name: "plan-auth.md", createdAt: 200 }),
  ];
  assert.equal(findStalePlans(docs).length, 0);
});

test("findStalePlans: unrelated plans are not flagged", () => {
  const docs = [
    mkDoc({ id: "d1", name: "plan-auth.md", createdAt: 100 }),
    mkDoc({ id: "d2", name: "plan-billing.md", createdAt: 200 }),
  ];
  assert.equal(findStalePlans(docs).length, 0);
});

test("findStalePlans: substring-but-not-prefix is NOT flagged (round-40 false-positive guard)", () => {
  // 'auth' is a substring of 'oauth' — the old bare `includes` check
  // would wrongly flag plan-auth.md when plan-oauth.md exists. The
  // delimiter-aware startsWith(slug + '-') check must NOT flag these.
  const docs = [
    mkDoc({ id: "d1", name: "plan-auth.md", createdAt: 100 }),
    mkDoc({ id: "d2", name: "plan-oauth.md", createdAt: 200 }),
  ];
  assert.equal(findStalePlans(docs).length, 0);
});

test("findStalePlans: prefix-without-delimiter is NOT flagged (authz vs auth)", () => {
  // 'plan-auth.md' should NOT be flagged by 'plan-authz.md' — authz is
  // not a hyphen-delimited extension of auth. Only 'plan-auth-<x>.md'
  // counts as a rename leftover.
  const docs = [
    mkDoc({ id: "d1", name: "plan-auth.md", createdAt: 100 }),
    mkDoc({ id: "d2", name: "plan-authz.md", createdAt: 200 }),
  ];
  assert.equal(findStalePlans(docs).length, 0);
});

test("findStalePlans: non-plan-named docs in the slot are ignored", () => {
  // A hand-added doc not following the plan-<slug>.md convention must
  // not participate in stale-plan detection (round-40 guard).
  const docs = [
    mkDoc({ id: "d1", name: "notes.md", createdAt: 100 }),
    mkDoc({ id: "d2", name: "notes-extended.md", createdAt: 200 }),
    mkDoc({ id: "d3", name: "plan-auth.md", createdAt: 300 }),
  ];
  assert.equal(findStalePlans(docs).length, 0);
});

test("indexDocMetadata: non-array doc_metadata is treated as empty (does not throw)", () => {
  // Round-40 guard: Dify returning a non-array doc_metadata (object,
  // string) must not abort the audit run via a for..of throw.
  assert.deepEqual(indexDocMetadata({ doc_metadata: { not: "an-array" } }), {});
  assert.deepEqual(indexDocMetadata({ doc_metadata: "weird" }), {});
  assert.deepEqual(indexDocMetadata({ doc_metadata: 42 }), {});
});

// ---------- findMissingMetadata ----------

test("findMissingMetadata: lesson without project_module/task_type/error_pattern flagged", () => {
  const docs = [
    mkDoc({ id: "L1", name: "lesson-x.md", createdAt: 1, metadata: { atom_type: "self-improvement-lesson" } }),
  ];
  const out = findMissingMetadata(docs, "self_improvement");
  assert.equal(out.length, 1);
  assert.equal(out[0].documentId, "L1");
  assert.ok(out[0].reason.includes("project_module"));
  assert.ok(out[0].reason.includes("task_type"));
  assert.ok(out[0].reason.includes("error_pattern"));
  assert.equal(out[0].suggested_action, "disable");
});

test("findMissingMetadata: bug-root-cause without project_module flagged", () => {
  const docs = [
    mkDoc({ id: "B1", name: "knowledge-x.md", createdAt: 1, metadata: { atom_type: "bug-root-cause" } }),
  ];
  const out = findMissingMetadata(docs, "knowledge");
  assert.equal(out.length, 1);
  assert.equal(out[0].documentId, "B1");
});

test("findMissingMetadata: well-formed lesson is not flagged", () => {
  const docs = [
    mkDoc({
      id: "L2",
      name: "lesson-x.md",
      createdAt: 1,
      metadata: {
        atom_type: "self-improvement-lesson",
        project_module: "auth",
        task_type: "review",
        error_pattern: "missing-await",
      },
    }),
  ];
  assert.equal(findMissingMetadata(docs, "self_improvement").length, 0);
});

test("findMissingMetadata: untyped (project-lore etc.) docs are not flagged", () => {
  const docs = [
    mkDoc({ id: "P1", name: "knowledge-x.md", createdAt: 1, metadata: { atom_type: "project-lore" } }),
    mkDoc({ id: "P2", name: "knowledge-y.md", createdAt: 1, metadata: { atom_type: "decision" } }),
  ];
  assert.equal(findMissingMetadata(docs, "knowledge").length, 0);
});

test("findMissingMetadata: plan-typed docs in the plans slot are never flagged (no required fields)", () => {
  // Defensive lock for the slot-walk tightening in audit_memory tool:
  // plans don't have required metadata fields, so even if we walked them
  // findMissingMetadata would return zero. The tool excludes the plans
  // slot from the missing-metadata walk for efficiency, but the helper
  // contract must remain correct in case a future caller walks plans
  // anyway.
  const docs = [
    mkDoc({ id: "PL1", name: "plan-foo.md", createdAt: 1, metadata: { atom_type: "plan" } }),
    mkDoc({ id: "PL2", name: "plan-bar.md", createdAt: 1, metadata: {} }),
  ];
  assert.equal(findMissingMetadata(docs, "plans").length, 0);
});

// ---------- findStaleProjectLore ----------

test("findStaleProjectLore: project-lore older than threshold is flagged", () => {
  const now = 1_000_000_000 * 1000; // ms
  const day = 24 * 60 * 60 * 1000;
  const docs = [
    mkDoc({
      id: "L1",
      name: "knowledge-x.md",
      createdAt: (now - 120 * day) / 1000, // 120 days ago
      metadata: { atom_type: "project-lore" },
    }),
  ];
  const out = findStaleProjectLore(docs, "knowledge", 90, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].class, "stale-project-lore");
  assert.equal(out[0].suggested_action, "disable");
  assert.ok(out[0].reason.includes("120 days"));
});

test("findStaleProjectLore: project-lore younger than threshold not flagged", () => {
  const now = 1_000_000_000 * 1000;
  const day = 24 * 60 * 60 * 1000;
  const docs = [
    mkDoc({
      id: "L1",
      name: "knowledge-x.md",
      createdAt: (now - 10 * day) / 1000,
      metadata: { atom_type: "project-lore" },
    }),
  ];
  assert.equal(findStaleProjectLore(docs, "knowledge", 90, now).length, 0);
});

test("findStaleProjectLore: non-project-lore atoms are ignored even when ancient", () => {
  const now = 1_000_000_000 * 1000;
  const day = 24 * 60 * 60 * 1000;
  const docs = [
    mkDoc({
      id: "L1",
      name: "knowledge-x.md",
      createdAt: (now - 1000 * day) / 1000,
      metadata: { atom_type: "decision" },
    }),
  ];
  assert.equal(findStaleProjectLore(docs, "knowledge", 90, now).length, 0);
});

// ---------- findDuplicateErrorPatternLessons ----------

test("findDuplicateErrorPatternLessons: two lessons same error_pattern -> older flagged", () => {
  const docs = [
    mkDoc({
      id: "L1",
      name: "lesson-a.md",
      createdAt: 100,
      metadata: { atom_type: "self-improvement-lesson", error_pattern: "p1" },
    }),
    mkDoc({
      id: "L2",
      name: "lesson-b.md",
      createdAt: 200,
      metadata: { atom_type: "self-improvement-lesson", error_pattern: "p1" },
    }),
  ];
  const out = findDuplicateErrorPatternLessons(docs, "self_improvement");
  assert.equal(out.length, 1);
  assert.equal(out[0].documentId, "L1"); // older one is the dupe
  assert.equal(out[0].suggested_action, "delete");
  assert.ok(out[0].reason.includes("p1"));
});

test("findDuplicateErrorPatternLessons: distinct error_patterns not flagged", () => {
  const docs = [
    mkDoc({ id: "L1", name: "a.md", createdAt: 1, metadata: { atom_type: "self-improvement-lesson", error_pattern: "p1" } }),
    mkDoc({ id: "L2", name: "b.md", createdAt: 2, metadata: { atom_type: "self-improvement-lesson", error_pattern: "p2" } }),
  ];
  assert.equal(findDuplicateErrorPatternLessons(docs, "self_improvement").length, 0);
});

test("findDuplicateErrorPatternLessons: lessons without error_pattern are ignored", () => {
  const docs = [
    mkDoc({ id: "L1", name: "a.md", createdAt: 1, metadata: { atom_type: "self-improvement-lesson" } }),
    mkDoc({ id: "L2", name: "b.md", createdAt: 2, metadata: { atom_type: "self-improvement-lesson" } }),
  ];
  assert.equal(findDuplicateErrorPatternLessons(docs, "self_improvement").length, 0);
});

test("findDuplicateErrorPatternLessons: three lessons share pattern -> two oldest flagged", () => {
  const docs = [
    mkDoc({ id: "L1", name: "a.md", createdAt: 1, metadata: { atom_type: "self-improvement-lesson", error_pattern: "p1" } }),
    mkDoc({ id: "L2", name: "b.md", createdAt: 2, metadata: { atom_type: "self-improvement-lesson", error_pattern: "p1" } }),
    mkDoc({ id: "L3", name: "c.md", createdAt: 3, metadata: { atom_type: "self-improvement-lesson", error_pattern: "p1" } }),
  ];
  const out = findDuplicateErrorPatternLessons(docs, "self_improvement");
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.documentId).sort(), ["L1", "L2"]);
});
