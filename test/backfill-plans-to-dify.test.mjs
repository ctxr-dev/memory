// Tests for scripts/backfill-plans-to-dify.mjs.
//
// Coverage scope: argument parsing, candidate collection (file filter,
// mtime ordering, redact/empty/skipsize gates, fencing), preflight gate,
// dry-run path. Live Dify pushes are NOT exercised (we don't want a
// test suite to write garbage into the developer's real plans dataset);
// the push path is covered by pushOne being a thin wrapper over the
// well-tested saveDocument helper, plus the existing dify-write tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  BackfillError,
  parseArgs,
  collectCandidates,
} from "../scripts/backfill-plans-to-dify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, "..", "scripts", "backfill-plans-to-dify.mjs");

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test("parseArgs: defaults", () => {
  const o = parseArgs([]);
  assert.equal(o.dryRun, false);
  assert.equal(o.limit, Infinity);
  assert.ok(o.plansDir.endsWith(path.join(".claude", "plans")));
});

test("parseArgs: --dry-run", () => {
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["-n"]).dryRun, true);
});

test("parseArgs: --plans-dir=", () => {
  const o = parseArgs(["--plans-dir=/tmp/foo"]);
  assert.equal(o.plansDir, "/tmp/foo");
});

test("parseArgs: --limit=N", () => {
  assert.equal(parseArgs(["--limit=5"]).limit, 5);
});

test("parseArgs: invalid --limit raises BackfillError exitCode=3", () => {
  assert.throws(() => parseArgs(["--limit=foo"]), (err) => {
    assert.ok(err instanceof BackfillError);
    assert.equal(err.exitCode, 3);
    return true;
  });
});

test("parseArgs: unknown arg raises BackfillError exitCode=3", () => {
  assert.throws(() => parseArgs(["--unknown"]), (err) => {
    assert.ok(err instanceof BackfillError);
    assert.equal(err.exitCode, 3);
    return true;
  });
});

// ---------------------------------------------------------------------------
// collectCandidates
// ---------------------------------------------------------------------------

function makePlansDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body, mtime] of files) {
    const full = path.join(dir, name);
    fs.writeFileSync(full, body);
    if (mtime) fs.utimesSync(full, mtime / 1000, mtime / 1000);
  }
  return dir;
}

test("collectCandidates: missing dir raises BackfillError exitCode=3", () => {
  assert.throws(() => collectCandidates("/nonexistent/plans/dir"), (err) => {
    assert.ok(err instanceof BackfillError);
    assert.equal(err.exitCode, 3);
    return true;
  });
});

test("collectCandidates: empty dir returns no candidates", (t) => {
  const dir = makePlansDir(t, []);
  const { candidates, skips } = collectCandidates(dir);
  assert.equal(candidates.length, 0);
  assert.equal(skips.length, 0);
});

test("collectCandidates: ignores non-.md files", (t) => {
  const dir = makePlansDir(t, [
    ["plan1.md", "# Hello\nbody"],
    ["notes.txt", "ignored"],
    ["junk.json", "{}"],
  ]);
  const { candidates } = collectCandidates(dir);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].title, "Hello");
});

test("collectCandidates: sorts by mtime ASC (oldest first)", (t) => {
  const dir = makePlansDir(t, [
    ["new.md", "# Newer\nbody", Date.now()],
    ["old.md", "# Older\nbody", Date.now() - 100_000],
  ]);
  const { candidates } = collectCandidates(dir);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].title, "Older");
  assert.equal(candidates[1].title, "Newer");
});

test("collectCandidates: skips empty-after-redaction body", (t) => {
  const dir = makePlansDir(t, [["empty.md", "   \n   \n"]]);
  const { candidates, skips } = collectCandidates(dir);
  assert.equal(candidates.length, 0);
  assert.equal(skips.length, 1);
  assert.match(skips[0].reason, /empty after redaction/);
});

test("collectCandidates: skips body larger than maxBytes", (t) => {
  const body = "# Big\n" + "x".repeat(2000);
  const dir = makePlansDir(t, [["big.md", body]]);
  const { candidates, skips } = collectCandidates(dir, { maxBytes: 100 });
  assert.equal(candidates.length, 0);
  assert.equal(skips.length, 1);
  assert.match(skips[0].reason, />100 bytes/);
});

test("collectCandidates: derives name from slugified title", (t) => {
  const dir = makePlansDir(t, [
    ["any.md", "# This Is A Plan!\nbody"],
  ]);
  const { candidates } = collectCandidates(dir);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, "plan-this-is-a-plan.md");
});

test("collectCandidates: fences each body", (t) => {
  const dir = makePlansDir(t, [["x.md", "# T\nbody"]]);
  const { candidates } = collectCandidates(dir);
  assert.match(candidates[0].text, /<!-- BEGIN UNTRUSTED PLAN BODY/);
  assert.match(candidates[0].text, /<!-- END UNTRUSTED PLAN BODY/);
  assert.match(candidates[0].text, /# T\nbody/);
});

// ---------------------------------------------------------------------------
// CLI integration: dry-run path (no bridge calls)
// ---------------------------------------------------------------------------

test("CLI: --dry-run prints what would be pushed, exits 0, no Dify calls", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "p1.md"), "# DryRun Plan\nbody");

  const r = spawnSync("node", [CLI, "--dry-run", `--plans-dir=${dir}`], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 0, `cli should exit 0; stderr: ${r.stderr}`);
  assert.match(r.stdout, /backfilling 1 plan/);
  assert.match(r.stdout, /dry-run: plan-dryrun-plan\.md/);
  assert.match(r.stdout, /done. ok=1, fail=0/);
});

test("CLI: empty plans dir prints 'no plans to push' and exits 0", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const r = spawnSync("node", [CLI, `--plans-dir=${dir}`], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no plans to push/);
});

test("CLI: --help prints help and exits 0", () => {
  const r = spawnSync("node", [CLI, "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Backfill Claude Code plans/);
  assert.match(r.stdout, /--dry-run/);
});

test("CLI: invalid --limit exits 3", () => {
  const r = spawnSync("node", [CLI, "--limit=foo"], { encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /invalid --limit/);
});

test("CLI: missing plans-dir exits 3", () => {
  const r = spawnSync("node", [CLI, "--plans-dir=/totally/missing/dir"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /plans dir does not exist/);
});
