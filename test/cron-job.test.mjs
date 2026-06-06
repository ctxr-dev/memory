// Lock the cron-job self-healing orchestration: overlap-skip, compile
// short-circuit, and the consolidate error / LLM-interrupt surfacing that drives
// cron_health. runCronJob takes injectable deps + statePaths so these run with NO
// real subprocess, lock, attempts log, OR escalation-state writes. Plus
// cronHealth/readAttempts classification against temp paths.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCronJob, cronHealth, readAttempts } from "../scripts/cron-job.mjs";

const okLock = () => ({ ok: true, release() {} });
function step(map) {
  return (scriptPath) => (scriptPath.endsWith("consolidate.mjs") ? map.consolidate : map.compile);
}
const OK = { ok: true, exit: 0, stderr: "", stdout: "" };

// Temp self-healing artifact paths so runCronJob never writes the real state dir.
const tmpDirs = [];
function mkSP() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-sp-"));
  tmpDirs.push(dir);
  return {
    entitiesPath: path.join(dir, ".consolidate-entities.json"),
    issuesIndexPath: path.join(dir, ".issues-index.json"),
    issuesDir: path.join(dir, "issues"),
    cronLogsDir: path.join(dir, "logs"),
    dataDir: dir,
    attemptsLogPath: path.join(dir, "attempts.log"),
  };
}
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

test("runCronJob: another holder of the lock -> benign overlap skip, nothing appended", async () => {
  const appended = [];
  const res = await runCronJob({ acquireLockFn: () => ({ ok: false, reason: "held" }), runStepFn: () => OK, appendFn: (e) => appended.push(e), statePaths: mkSP() });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, "overlap");
  assert.equal(appended.length, 0, "overlap must not append an attempt");
});

test("runCronJob: compile failure short-circuits (consolidate not run) and is logged ok:false", async () => {
  const appended = [];
  let consolidateRan = false;
  const runStepFn = (scriptPath) => {
    if (scriptPath.endsWith("consolidate.mjs")) { consolidateRan = true; return OK; }
    return { ok: false, exit: 1, stderr: "compile boom", stdout: "" };
  };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn, appendFn: (e) => appended.push(e), statePaths: mkSP() });
  assert.equal(res.ok, false);
  assert.match(res.error, /compile exit 1/);
  assert.equal(consolidateRan, false, "compile failure must short-circuit before consolidate");
  assert.equal(appended.length, 1);
});

test("runCronJob: compile exit 69 (providers unavailable) -> failed + short-circuit, labelled retryable", async () => {
  const appended = [];
  let consolidateRan = false;
  const runStepFn = (scriptPath) => {
    if (scriptPath.endsWith("consolidate.mjs")) { consolidateRan = true; return OK; }
    return { ok: false, exit: 69, stderr: "compile.mjs: aborting (DifyBridgeUnavailable): no container", stdout: "" };
  };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn, appendFn: (e) => appended.push(e), statePaths: mkSP() });
  assert.equal(res.ok, false, "exit 69 is a failed attempt, not healthy");
  assert.match(res.error, /providers unavailable \(exit 69\)/);
  assert.match(res.error, /will retry/);
  assert.equal(consolidateRan, false, "exit 69 short-circuits consolidate");
  assert.equal(appended.length, 1);
});

test("runCronJob: clean compile + clean consolidate -> ok:true, no error; summary carries llm/llmRequested", async () => {
  const appended = [];
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: JSON.stringify({ ok: true, dryRun: false, totals: { errors: 0 }, workingSetSize: 5, llm: true, llmRequested: true }) };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: (e) => appended.push(e), statePaths: mkSP() });
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].consolidate.summary.workingSetSize, 5);
  assert.equal(appended[0].consolidate.summary.llm, true, "llm surfaced in the slim summary");
  assert.equal(appended[0].consolidate.summary.llmRequested, true, "llmRequested surfaced in the slim summary");
});

test("runCronJob: consolidate reports totals.errors -> surfaced as a failure (not masked)", async () => {
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: JSON.stringify({ ok: true, totals: { errors: 2 } }) };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {}, statePaths: mkSP() });
  assert.equal(res.ok, false);
  assert.match(res.error, /2 error\(s\)/);
});

test("runCronJob: consolidate llmInterrupted -> surfaced as a failure so cron_health flags it", async () => {
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: JSON.stringify({ ok: true, totals: { errors: 0 }, llmInterrupted: true }) };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {}, statePaths: mkSP() });
  assert.equal(res.ok, false);
  assert.match(res.error, /LLM provider unavailable mid-run/);
});

test("runCronJob: consolidate non-zero exit -> failure with the exit + stderr", async () => {
  const consolidate = { ok: false, exit: 3, stderr: "consolidate died", stdout: "" };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {}, statePaths: mkSP() });
  assert.equal(res.ok, false);
  assert.match(res.error, /consolidate exit 3/);
});

test("runCronJob: consolidate exit 0 but unparseable JSON -> failure, with stdout REDACTED", async () => {
  const secret = "ghp_" + "A".repeat(36);
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: `oops ${secret} not json` };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {}, statePaths: mkSP() });
  assert.equal(res.ok, false);
  assert.match(res.error, /unparseable/);
  assert.ok(!res.error.includes(secret), "raw secret must not appear in the surfaced error");
  assert.match(res.error, /ghp_\[REDACTED\]/, "stdout is redacted");
});

// ---- cronHealth / readAttempts classification (temp paths) ----

function withTempLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-health-"));
  tmpDirs.push(dir);
  // Mark the temp dir as a real install (state/ marker) so cronHealth's mis-set
  // guard treats it as assessable; callers pass dataDir: dir.
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const p = path.join(dir, "attempts.log");
  fs.writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (lines.length ? "\n" : ""));
  // A nonexistent issues index so no real escalations leak into the classification.
  return { p, dir, issuesIndexPath: path.join(dir, "nope-issues.json") };
}

test("cronHealth: empty/absent log is healthy with a 'fresh' summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-health-none-"));
  tmpDirs.push(dir);
  // A real-but-fresh install: data dir + state/ marker present, just no tick yet.
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  const h = cronHealth({ dataDir: dir, logPath: path.join(dir, "nope.log"), issuesIndexPath: path.join(dir, "nope-issues.json") });
  assert.equal(h.healthy, true);
  assert.match(h.summary, /no cron-job attempts/);
  assert.equal(h.lastAttempt, null);
});

test("cronHealth: mis-set MEMORY_DATA_DIR (absent path) is NOT healthy (closes the silent-green footgun)", () => {
  // The footgun: a mis-set data dir reads nothing and would otherwise look 'fresh'.
  const gone = path.join(os.tmpdir(), "cron-health-misset-does-not-exist-xyzzy");
  const h = cronHealth({ dataDir: gone, logPath: path.join(gone, "attempts.log"), issuesIndexPath: path.join(gone, "issues.json") });
  assert.equal(h.healthy, false);
  assert.equal(h.ok, false);
  assert.match(h.summary, /mis-set|absent|not a memory install/i);
  assert.equal(h.lastAttempt, null);
});

test("cronHealth: data dir exists but is NOT a memory install (no markers) is NOT healthy", () => {
  // Mis-set to an unrelated existing dir (e.g. $HOME): exists, but no settings/.env
  // and no state/ -> must not be read as a fresh-healthy install.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-health-bare-"));
  tmpDirs.push(dir);
  const h = cronHealth({ dataDir: dir, logPath: path.join(dir, "nope.log"), issuesIndexPath: path.join(dir, "nope-issues.json") });
  assert.equal(h.healthy, false);
  assert.equal(h.ok, false);
});

test("cronHealth: last attempt ok:false -> unhealthy with the error", () => {
  const { p, dir, issuesIndexPath } = withTempLog([
    { ts: "2026-06-03T10:00:00Z", ok: true },
    { ts: "2026-06-03T11:00:00Z", ok: false, error: "consolidate completed with 1 error(s)" },
  ]);
  const h = cronHealth({ dataDir: dir, logPath: p, issuesIndexPath });
  assert.equal(h.healthy, false);
  assert.match(h.summary, /UNRESOLVED FAILURE/);
  assert.match(h.summary, /1 error/);
});

test("cronHealth: last ok with an earlier failure -> healthy but reports lastFailureAt", () => {
  const { p, dir, issuesIndexPath } = withTempLog([
    { ts: "2026-06-03T10:00:00Z", ok: false, error: "x" },
    { ts: "2026-06-03T11:00:00Z", ok: true },
  ]);
  const h = cronHealth({ dataDir: dir, logPath: p, issuesIndexPath });
  assert.equal(h.healthy, true);
  assert.equal(h.lastFailureAt, "2026-06-03T10:00:00Z");
});

test("readAttempts: parses JSONL, skips malformed lines, respects limit", () => {
  const { p } = withTempLog([
    { ts: "a", ok: true },
    "{ not json",
    { ts: "b", ok: true },
    { ts: "c", ok: true },
  ]);
  const all = readAttempts({ logPath: p });
  assert.deepEqual(all.map((a) => a.ts), ["a", "b", "c"], "malformed line skipped");
  const last2 = readAttempts({ logPath: p, limit: 2 });
  assert.deepEqual(last2.map((a) => a.ts), ["b", "c"]);
});
