// Lock the cron-job self-healing orchestration: overlap-skip, compile
// short-circuit, and the consolidate error / LLM-interrupt surfacing that drives
// cron_health. runCronJob takes injectable deps so these run with NO real
// subprocess, lock, or attempts-log write. Plus cronHealth/readAttempts
// classification against a temp log. Regression (review): only runStep was tested.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCronJob, cronHealth, readAttempts } from "../scripts/cron-job.mjs";

const okLock = () => ({ ok: true, release() {} });
function step(map) {
  // map: { compile: result, consolidate: result }; pick by script path tail.
  return (scriptPath) => (scriptPath.endsWith("consolidate.mjs") ? map.consolidate : map.compile);
}
const OK = { ok: true, exit: 0, stderr: "", stdout: "" };

test("runCronJob: another holder of the lock -> benign overlap skip, nothing appended", async () => {
  const appended = [];
  const res = await runCronJob({ acquireLockFn: () => ({ ok: false, reason: "held" }), runStepFn: () => OK, appendFn: (e) => appended.push(e) });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, "overlap");
  assert.equal(appended.length, 0, "overlap must not append an attempt");
});

test("runCronJob: compile failure short-circuits (consolidate not run) and is logged ok:false", async () => {
  const appended = [];
  let consolidateRan = false;
  const runStepFn = (scriptPath, args) => {
    if (scriptPath.endsWith("consolidate.mjs")) { consolidateRan = true; return OK; }
    return { ok: false, exit: 1, stderr: "compile boom", stdout: "" };
  };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn, appendFn: (e) => appended.push(e) });
  assert.equal(res.ok, false);
  assert.match(res.error, /compile exit 1/);
  assert.equal(consolidateRan, false, "compile failure must short-circuit before consolidate");
  assert.equal(appended.length, 1);
});

test("runCronJob: clean compile + clean consolidate -> ok:true, no error", async () => {
  const appended = [];
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: JSON.stringify({ ok: true, dryRun: false, totals: { errors: 0 }, workingSetSize: 5 }) };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: (e) => appended.push(e) });
  assert.equal(res.ok, true);
  assert.equal(res.error, null);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].consolidate.summary.workingSetSize, 5);
});

test("runCronJob: consolidate reports totals.errors -> surfaced as a failure (not masked)", async () => {
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: JSON.stringify({ ok: true, totals: { errors: 2 } }) };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /2 error\(s\)/);
});

test("runCronJob: consolidate llmInterrupted -> surfaced as a failure so cron_health flags it", async () => {
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: JSON.stringify({ ok: true, totals: { errors: 0 }, llmInterrupted: true }) };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /LLM provider unavailable mid-run/);
});

test("runCronJob: consolidate non-zero exit -> failure with the exit + stderr", async () => {
  const consolidate = { ok: false, exit: 3, stderr: "consolidate died", stdout: "" };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /consolidate exit 3/);
});

test("runCronJob: consolidate exit 0 but unparseable JSON -> failure, with stdout REDACTED", async () => {
  // The unparseable stdout is embedded in the error (persisted + surfaced via
  // cron_health), so any secret a child printed must be scrubbed.
  const secret = "ghp_" + "A".repeat(36);
  const consolidate = { ok: true, exit: 0, stderr: "", stdout: `oops ${secret} not json` };
  const res = await runCronJob({ acquireLockFn: okLock, runStepFn: step({ compile: OK, consolidate }), appendFn: () => {} });
  assert.equal(res.ok, false);
  assert.match(res.error, /unparseable/);
  assert.ok(!res.error.includes(secret), "raw secret must not appear in the surfaced error");
  assert.match(res.error, /ghp_\[REDACTED\]/, "stdout is redacted");
});

// ---- cronHealth / readAttempts classification (temp log) ----

function withTempLog(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-health-"));
  const p = path.join(dir, "attempts.log");
  fs.writeFileSync(p, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (lines.length ? "\n" : ""));
  return { p, dir };
}

test("cronHealth: empty/absent log is healthy with a 'fresh' summary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-health-none-"));
  try {
    const h = cronHealth({ logPath: path.join(dir, "nope.log") });
    assert.equal(h.healthy, true);
    assert.match(h.summary, /no cron-job attempts/);
    assert.equal(h.lastAttempt, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cronHealth: last attempt ok:false -> unhealthy with the error", () => {
  const { p, dir } = withTempLog([
    { ts: "2026-06-03T10:00:00Z", ok: true },
    { ts: "2026-06-03T11:00:00Z", ok: false, error: "consolidate completed with 1 error(s)" },
  ]);
  try {
    const h = cronHealth({ logPath: p });
    assert.equal(h.healthy, false);
    assert.match(h.summary, /UNRESOLVED FAILURE/);
    assert.match(h.summary, /1 error/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cronHealth: last ok with an earlier failure -> healthy but reports lastFailureAt", () => {
  const { p, dir } = withTempLog([
    { ts: "2026-06-03T10:00:00Z", ok: false, error: "x" },
    { ts: "2026-06-03T11:00:00Z", ok: true },
  ]);
  try {
    const h = cronHealth({ logPath: p });
    assert.equal(h.healthy, true);
    assert.equal(h.lastFailureAt, "2026-06-03T10:00:00Z");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("readAttempts: parses JSONL, skips malformed lines, respects limit", () => {
  const { p, dir } = withTempLog([
    { ts: "a", ok: true },
    "{ not json",
    { ts: "b", ok: true },
    { ts: "c", ok: true },
  ]);
  try {
    const all = readAttempts({ logPath: p });
    assert.deepEqual(all.map((a) => a.ts), ["a", "b", "c"], "malformed line skipped");
    const last2 = readAttempts({ logPath: p, limit: 2 });
    assert.deepEqual(last2.map((a) => a.ts), ["b", "c"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
