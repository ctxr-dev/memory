// Lock the self-healing escalation lifecycle: synthetic provider entities feed
// the SAME entity-state/escalation/issue-report machinery; a provider that stays
// unavailable for N consecutive ticks escalates into a skeleton issue report, and
// the first healthy tick resolves the episode. ENOENT vs timeout open DISTINCT
// episodes. All state goes to a temp dir (no real-state writes).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  synthesizeProviderEntities,
  updateEntityState,
  evaluateEscalations,
  writeIssueReports,
  readEntityState,
  readIssuesIndex,
  runCronJob,
  cronHealth,
} from "../scripts/cron-job.mjs";

const COMPILE_ENTITY = "system:compile-llm-providers";
const tmpDirs = [];
function mkSP() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-heal-"));
  tmpDirs.push(dir);
  // state/ marker so cronHealth's mis-set-data-dir guard treats this temp dir as
  // a real install (the calls below pass dataDir: sp.dataDir).
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
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
const okLock = () => ({ ok: true, release() {} });

test("synthesizeProviderEntities: compile-69 failure, compile-ok success, consolidate llm-skip/ok, none on skip/dry", () => {
  const fail = synthesizeProviderEntities({ compileExit: 69, compileError: "spawn claude ENOENT" });
  assert.equal(fail["compile-promote"].failures[0].id, COMPILE_ENTITY);
  assert.equal(fail["compile-promote"].failures[0].ok, false);

  const ok = synthesizeProviderEntities({ compileOk: true });
  assert.equal(ok["compile-promote"].entities[0].id, COMPILE_ENTITY);

  const llmSkip = synthesizeProviderEntities({ compileOk: true, report: { llmRequested: true, llm: false } });
  assert.equal(llmSkip["consolidate-llm"].failures[0].id, "system:consolidate-llm-providers");
  const llmOk = synthesizeProviderEntities({ compileOk: true, report: { llmRequested: true, llm: true } });
  assert.equal(llmOk["consolidate-llm"].entities[0].ok, true);
  // llmInterrupted also counts as a skip.
  const llmInt = synthesizeProviderEntities({ compileOk: true, report: { llmRequested: true, llm: true, llmInterrupted: true } });
  assert.equal(llmInt["consolidate-llm"].failures.length, 1);

  // A skipped / dry-run / --no-llm consolidate contributes no consolidate-llm signal.
  assert.equal(synthesizeProviderEntities({ compileOk: true, report: { skipped: "not-due", llmRequested: true } })["consolidate-llm"], undefined);
  assert.equal(synthesizeProviderEntities({ compileOk: true, report: { dryRun: true, llmRequested: true } })["consolidate-llm"], undefined);
  assert.equal(synthesizeProviderEntities({ compileOk: true, report: { llmRequested: false } })["consolidate-llm"], undefined);
});

test("updateEntityState + evaluateEscalations: escalate after N consecutive failures; success resolves", () => {
  const state = { version: 1, entities: {} };
  const passes = synthesizeProviderEntities({ compileExit: 69, compileError: "spawn claude ENOENT" });
  for (let i = 1; i <= 3; i += 1) {
    updateEntityState(state, { passes }, { ts: `2026-06-05T0${i}:00:00Z`, logPath: "logs/x.json", escalateAfter: 3 });
    const esc = evaluateEscalations(state, { escalateAfter: 3 });
    if (i < 3) assert.equal(esc.length, 0, `no escalation before the threshold (tick ${i})`);
    else {
      assert.equal(esc.length, 1, "escalates on the 3rd consecutive failure");
      assert.equal(esc[0].reason, "pending-consecutive");
      assert.equal(esc[0].attempts, 3);
    }
  }
  // A success tick deletes the entity -> no escalation.
  updateEntityState(state, { passes: synthesizeProviderEntities({ compileOk: true }) }, { ts: "2026-06-05T04:00:00Z", logPath: "logs/y.json", escalateAfter: 3 });
  assert.equal(Object.keys(state.entities).length, 0, "success resolves the entity");
  assert.equal(evaluateEscalations(state, { escalateAfter: 3 }).length, 0);
});

test("BUG_FANOUT: one signature across 3 distinct entities escalates even below the consecutive threshold", () => {
  const state = { version: 1, entities: {} };
  // Three distinct leaf entities, same error text -> same signature, 1 failure each.
  const passes = {
    merge: {
      name: "merge",
      entities: [],
      failures: [
        { id: "leaf:a", kind: "leaf", excerpt: "merge write failed" },
        { id: "leaf:b", kind: "leaf", excerpt: "merge write failed" },
        { id: "leaf:c", kind: "leaf", excerpt: "merge write failed" },
      ],
    },
  };
  updateEntityState(state, { passes }, { ts: "2026-06-05T01:00:00Z", logPath: "logs/x.json", escalateAfter: 3 });
  const esc = evaluateEscalations(state, { escalateAfter: 3 });
  assert.equal(esc.length, 1, "recurring signature across >=3 entities escalates");
  assert.equal(esc[0].reason, "recurring-bug");
  assert.equal(esc[0].entityCount, 3);
});

test("writeIssueReports: writes a redacted skeleton + index; resolves in place when the signature goes live-free", () => {
  const sp = mkSP();
  const state = { version: 1, entities: {} };
  const passes = synthesizeProviderEntities({ compileExit: 69, compileError: "spawn claude ENOENT; secret ghp_" + "A".repeat(36) });
  for (let i = 1; i <= 3; i += 1) {
    updateEntityState(state, { passes }, { ts: `2026-06-05T0${i}:00:00Z`, logPath: "logs/x.json", escalateAfter: 3 });
  }
  const esc = evaluateEscalations(state, { escalateAfter: 3 });
  const res = writeIssueReports(esc, state, new Date("2026-06-05T03:00:00Z"), { issuesDir: sp.issuesDir, issuesIndexPath: sp.issuesIndexPath, dataDir: sp.dataDir });
  assert.equal(res.openCount, 1);
  const idx = readIssuesIndex({ issuesIndexPath: sp.issuesIndexPath, issuesDir: sp.issuesDir });
  const sig = Object.keys(idx.signatures)[0];
  assert.equal(idx.signatures[sig].status, "open");
  const reportAbs = path.join(sp.dataDir, idx.signatures[sig].path);
  const body = fs.readFileSync(reportAbs, "utf8");
  assert.match(body, /^status: open/m);
  assert.ok(!body.includes("ghp_AAAA"), "issue report is redacted");
  // Resolution: a state with no live signature flips the open episode to resolved.
  const resolved = writeIssueReports([], { version: 1, entities: {} }, new Date("2026-06-05T05:00:00Z"), { issuesDir: sp.issuesDir, issuesIndexPath: sp.issuesIndexPath, dataDir: sp.dataDir });
  assert.equal(resolved.openCount, 0, "no live signature -> episode resolved");
  assert.match(fs.readFileSync(reportAbs, "utf8"), /^status: resolved/m);
});

test("distinct root causes (ENOENT vs timeout) open SEPARATE issue reports", () => {
  const sp = mkSP();
  const build = (errText) => {
    const s = { version: 1, entities: {} };
    const passes = synthesizeProviderEntities({ compileExit: 69, compileError: errText });
    for (let i = 1; i <= 3; i += 1) updateEntityState(s, { passes }, { ts: `2026-06-05T0${i}:00:00Z`, logPath: "l", escalateAfter: 3 });
    return s;
  };
  // Two separate entity-states (e.g. two boxes / two episodes), written to the
  // same index: different signatures -> two distinct open reports.
  writeIssueReports(evaluateEscalations(build("spawn claude ENOENT"), { escalateAfter: 3 }), build("spawn claude ENOENT"), new Date("2026-06-05T03:00:00Z"), { issuesDir: sp.issuesDir, issuesIndexPath: sp.issuesIndexPath, dataDir: sp.dataDir });
  const merged = build("spawn claude ENOENT");
  const to = build("claude timed out after 120000ms");
  // Combine both live entities into one state so neither resolves the other.
  const combined = { version: 1, entities: { ...merged.entities, ["system:compile-llm-providers#to"]: Object.values(to.entities)[0] } };
  const allEsc = evaluateEscalations(combined, { escalateAfter: 3 });
  writeIssueReports(allEsc, combined, new Date("2026-06-05T04:00:00Z"), { issuesDir: sp.issuesDir, issuesIndexPath: sp.issuesIndexPath, dataDir: sp.dataDir });
  const idx = readIssuesIndex({ issuesIndexPath: sp.issuesIndexPath, issuesDir: sp.issuesDir });
  const sigs = Object.keys(idx.signatures);
  assert.ok(sigs.length >= 2, "ENOENT and timeout are different signatures -> different reports");
});

test("full runCronJob lifecycle: 3 compile-69 ticks escalate; cron_health flips unhealthy then resolves", async () => {
  const sp = mkSP();
  const compile69 = (scriptPath) => (scriptPath.endsWith("consolidate.mjs")
    ? { ok: true, exit: 0, stderr: "", stdout: "{}" }
    : { ok: false, exit: 69, stderr: "compile.mjs: aborting (DifyBridgeUnavailable): spawn claude ENOENT", stdout: "" });
  for (let i = 0; i < 3; i += 1) {
    await runCronJob({ acquireLockFn: okLock, runStepFn: compile69, statePaths: sp });
  }
  let h = cronHealth({ dataDir: sp.dataDir, logPath: sp.attemptsLogPath, issuesIndexPath: sp.issuesIndexPath, issuesDir: sp.issuesDir });
  assert.equal(h.healthy, false, "3 consecutive provider-unavailable ticks -> unhealthy");
  assert.ok(h.escalations.length >= 1, "an open escalation is surfaced");

  // A healthy tick: compile ok + a real consolidate run -> resolves the episode.
  const healthy = (scriptPath) => (scriptPath.endsWith("consolidate.mjs")
    ? { ok: true, exit: 0, stderr: "", stdout: JSON.stringify({ ok: true, dryRun: false, totals: { errors: 0 }, llm: true, llmRequested: true }) }
    : { ok: true, exit: 0, stderr: "", stdout: "" });
  await runCronJob({ acquireLockFn: okLock, runStepFn: healthy, statePaths: sp });
  h = cronHealth({ dataDir: sp.dataDir, logPath: sp.attemptsLogPath, issuesIndexPath: sp.issuesIndexPath, issuesDir: sp.issuesDir });
  assert.equal(h.healthy, true, "first healthy tick resolves the episode");
  assert.equal(h.escalations.length, 0);
});
