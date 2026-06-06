// Cron-driven maintenance runner: compile + consolidate --if-due, with
// entity-level self-healing escalation.
//
// bootstrap.sh --schedule daily installs an HOURLY cron (launchd on macOS,
// crontab on Linux) that invokes this. The heavy work is bounded by each step's
// own throttle:
//   - compile.mjs's per-UTC-day state (.compile-state.json)
//   - consolidate.mjs's --if-due rolling window (MEMORY_CONSOLIDATE_INTERVAL_DAYS)
// So hourly attempts do real work at most once per day.
//
// Logging is two-tier:
//   - state/.consolidate-attempts.log keeps the last MEMORY_CONSOLIDATE_ATTEMPTS_KEEP
//     SLIM entries (one JSON line per run);
//   - state/logs/<yyyy>/<mm>/cron-<epochMs>.json holds the FULL record (redacted
//     compile stdout/stderr + the complete consolidate report), pruned after
//     MEMORY_CONSOLIDATE_FULL_LOG_RETENTION_DAYS.
//
// Self-healing is judged per ENTITY, not per run: state/.consolidate-entities.json
// tracks consecutive per-entity failures across runs. An entity still failing
// after MEMORY_CONSOLIDATE_ESCALATE_AFTER_ATTEMPTS consecutive attempts (or one
// error signature recurring across BUG_FANOUT distinct entities) escalates into a
// skeleton issue report at issues/<yyyy>/<mm>/<dd>/<signature>.<version>.md
// (whole document redacted). Provider unavailability rides the SAME machinery via
// synthetic entities system:compile-llm-providers / system:consolidate-llm-providers.
// A transient failure that later succeeds resolves silently (report -> resolved).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  MEMORY_DIR,
  MEMORY_DATA_DIR,
  CONSOLIDATE_ATTEMPTS_LOG_PATH,
  CONSOLIDATE_ENTITIES_PATH,
  CRON_LOGS_DIR,
  ISSUES_DIR,
  ISSUES_INDEX_PATH,
  envInt,
  consolidateAttemptsKeep,
  consolidateFullLogRetentionDays,
  consolidateEscalateAfterAttempts,
} from "./lib/env.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lib/lock.mjs";
import { redact } from "./lib/redact.mjs";
import { writeFileAtomic } from "./lib/atomic-write.mjs";
import { dailyDatePath } from "./lib/slug.mjs";
import { normalizeErrorSignature } from "./lib/error-signature.mjs";

const STDERR_CAP_BYTES = 2000;
const STDOUT_CAP_BYTES = 64 * 1024;
// compile.mjs exits 69 (BSD EX_UNAVAILABLE) when daily docs are pending but no
// LLM/bridge provider is reachable: a retryable failed attempt, not a crash.
const EX_UNAVAILABLE = 69;
// Same error signature across this many DISTINCT entities looks like a code bug
// (not a per-leaf accident) and escalates even when individual entities resolved.
const BUG_FANOUT = 3;
// Hard sanity bound on tracked failing entities (pathological corpora only).
const MAX_TRACKED_ENTITIES = 5000;
// Synthetic self-healing entities for provider availability.
const SYNTH_COMPILE_ENTITY = "system:compile-llm-providers";
const SYNTH_CONSOLIDATE_ENTITY = "system:consolidate-llm-providers";
const SYNTH_COMPILE_PASS = "compile-promote";
const SYNTH_CONSOLIDATE_PASS = "consolidate-llm";
const CRON_LOG_RE = /^cron-(\d+)\.json$/;
// Bounded per-step timeout. Without it, a hung compile/consolidate (e.g. a stuck
// `docker exec` to the bridge) would let cron-job run forever holding the cron
// lock. On timeout spawnSync kills the child (SIGTERM); the step is a failure.
const STEP_TIMEOUT_MS = envInt("MEMORY_CRON_STEP_TIMEOUT_MS", 30 * 60 * 1000);
// Serialises cron-job runs so two overlapping invocations never race the log
// front-truncation / entity-state read-rewrite.
const CRON_LOCK_PATH = path.join(MEMORY_DATA_DIR, "state", ".cron-job.lock");

// Settings readers that can never fail the cron path.
function attemptsKeepSafe() {
  try { return consolidateAttemptsKeep(); } catch { return 50; }
}
function retentionDaysSafe() {
  try { return consolidateFullLogRetentionDays(); } catch { return 90; }
}
function escalateAfterSafe() {
  try { return consolidateEscalateAfterAttempts(); } catch { return 3; }
}

const collapse = (v) => String(v || "").replace(/\s+/g, " ").trim();
const relToDataDir = (abs) => path.relative(MEMORY_DATA_DIR, abs);

// ─── slim attempt log ──────────────────────────────────────────────────────

function appendAttempt(entry, { logPath = CONSOLIDATE_ATTEMPTS_LOG_PATH } = {}) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch (err) {
    process.stderr.write(`[cron-job] failed to append attempt log: ${err?.message || err}\n`);
    return;
  }
  try {
    const keepN = attemptsKeepSafe();
    const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    if (lines.length > keepN) {
      writeFileAtomic(logPath, lines.slice(-keepN).join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
}

export function readAttempts({ limit = 50, logPath = CONSOLIDATE_ATTEMPTS_LOG_PATH } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out.slice(-limit);
}

// ─── sharded full run logs ─────────────────────────────────────────────────

export function fullLogPathFor(date = new Date(), { cronLogsDir = CRON_LOGS_DIR } = {}) {
  const shard = dailyDatePath(date).split("/").slice(0, 2).join(path.sep); // yyyy/mm
  return path.join(cronLogsDir, shard, `cron-${date.getTime()}.json`);
}

function writeFullLog(absPath, fullEntry) {
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileAtomic(absPath, JSON.stringify(fullEntry, null, 2) + "\n");
    return relToDataDir(absPath);
  } catch (err) {
    process.stderr.write(`[cron-job] failed to write full run log: ${err?.message || err}\n`);
    return null;
  }
}

// Delete full logs older than the retention window. Age is parsed from the
// FILENAME epoch (never mtime). Best-effort throughout.
export function pruneFullLogs(now = new Date(), { retentionDays = retentionDaysSafe(), cronLogsDir = CRON_LOGS_DIR } = {}) {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;
  let years;
  try {
    years = fs.readdirSync(cronLogsDir);
  } catch {
    return { removed };
  }
  for (const yyyy of years) {
    const yearDir = path.join(cronLogsDir, yyyy);
    let months;
    try { months = fs.readdirSync(yearDir); } catch { continue; }
    for (const mm of months) {
      const monthDir = path.join(yearDir, mm);
      let files;
      try { files = fs.readdirSync(monthDir); } catch { continue; }
      for (const f of files) {
        const m = CRON_LOG_RE.exec(f);
        if (!m) continue;
        if (Number(m[1]) >= cutoff) continue;
        try { fs.rmSync(path.join(monthDir, f), { force: true }); removed++; } catch { /* skip */ }
      }
      try { if (fs.readdirSync(monthDir).length === 0) fs.rmdirSync(monthDir); } catch { /* best effort */ }
    }
    try { if (fs.readdirSync(yearDir).length === 0) fs.rmdirSync(yearDir); } catch { /* best effort */ }
  }
  return { removed };
}

// ─── per-entity attempt history ────────────────────────────────────────────

export function readEntityState({ entitiesPath = CONSOLIDATE_ENTITIES_PATH } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(entitiesPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.entities && typeof parsed.entities === "object") {
      return parsed;
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      process.stderr.write(`[cron-job] entity state unreadable (${err?.message || err}); rebuilding from the next run\n`);
    }
  }
  return { version: 1, entities: {} };
}

export function writeEntityState(state, { entitiesPath = CONSOLIDATE_ENTITIES_PATH } = {}) {
  try {
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(entitiesPath), { recursive: true }); // writeFileAtomic ENOENTs without the dir
    writeFileAtomic(entitiesPath, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`[cron-job] failed to write entity state: ${err?.message || err}\n`);
  }
}

// Fold one report's passes into the entity history:
//   - every per-entity FAILURE increments its consecutive counter;
//   - every per-entity SUCCESS deletes the key (resolved);
//   - an entity absent from both is left untouched, but entries idle past the
//     retention window are dropped. One increment per entity per RUN.
export function updateEntityState(state, report, { ts, logPath, escalateAfter }) {
  const passes = report?.passes || {};
  const historyCap = Math.max(escalateAfter + 2, 5);
  const succeeded = new Set();
  const failedNow = new Map();
  for (const [passName, pass] of Object.entries(passes)) {
    for (const e of pass?.entities || []) {
      if (e?.id) succeeded.add(e.id);
    }
    for (const f of pass?.failures || []) {
      if (f?.id) failedNow.set(f.id, { pass: passName, kind: f.kind, excerpt: f.excerpt });
    }
  }
  for (const [id, f] of failedNow) {
    const signature = normalizeErrorSignature(f.excerpt, { pass: f.pass, kind: f.kind });
    const cur = state.entities[id] || {
      kind: f.kind || "leaf",
      ids: id.startsWith("pair:") ? id.slice(5).split("|") : [id.replace(/^leaf:/, "")],
      consecutiveFailures: 0,
      firstFailedTs: ts,
      history: [],
    };
    cur.pass = f.pass;
    cur.consecutiveFailures += 1;
    cur.lastFailedTs = ts;
    cur.lastSignature = signature;
    cur.history.push({ ts, ok: false, signature, excerpt: f.excerpt, logPath });
    if (cur.history.length > historyCap) cur.history = cur.history.slice(-historyCap);
    state.entities[id] = cur;
  }
  for (const id of succeeded) {
    if (!failedNow.has(id)) delete state.entities[id];
  }
  // Age out entities that stopped being attempted entirely. Reference the TICK
  // timestamp (ts), not wall-clock Date.now(): keeps the fold deterministic /
  // hermetic and immune to clock skew (the caller already provides ts).
  const nowMs = Date.parse(ts) || Date.now();
  const idleCutoff = nowMs - retentionDaysSafe() * 86_400_000;
  for (const [id, ent] of Object.entries(state.entities)) {
    const lastMs = Date.parse(ent.lastFailedTs || "") || 0;
    if (lastMs < idleCutoff) delete state.entities[id];
  }
  const keys = Object.keys(state.entities);
  if (keys.length > MAX_TRACKED_ENTITIES) {
    keys
      .sort((a, b) => (Date.parse(state.entities[a].lastFailedTs || "") || 0) - (Date.parse(state.entities[b].lastFailedTs || "") || 0))
      .slice(0, keys.length - MAX_TRACKED_ENTITIES)
      .forEach((k) => delete state.entities[k]);
    process.stderr.write(`[cron-job] entity history exceeded ${MAX_TRACKED_ENTITIES}; oldest entries dropped\n`);
  }
  return state;
}

// Escalate when (a) an entity is still pending after N consecutive failures, or
// (b) one signature spans >= BUG_FANOUT distinct entities. Counter-based.
export function evaluateEscalations(state, { escalateAfter = escalateAfterSafe() } = {}) {
  const bySig = new Map();
  for (const [key, ent] of Object.entries(state.entities || {})) {
    if (!ent?.lastSignature || !(ent.consecutiveFailures >= 1)) continue;
    if (!bySig.has(ent.lastSignature)) bySig.set(ent.lastSignature, []);
    bySig.get(ent.lastSignature).push({ key, ...ent });
  }
  const escalations = [];
  for (const [signature, ents] of bySig) {
    const pending = ents.filter((e) => e.consecutiveFailures >= escalateAfter);
    const distinctEntities = [...new Set(ents.map((e) => e.key))];
    const distinctLeafIds = [...new Set(ents.flatMap((e) => e.ids || []))].sort();
    const looksLikeBug = distinctEntities.length >= BUG_FANOUT;
    if (pending.length === 0 && !looksLikeBug) continue;
    const histories = ents.flatMap((e) => e.history || []);
    escalations.push({
      signature,
      reason: pending.length > 0 ? "pending-consecutive" : "recurring-bug",
      sinceTs: ents.map((e) => e.firstFailedTs).sort()[0] || null,
      lastTs: ents.map((e) => e.lastFailedTs).sort().at(-1) || null,
      attempts: Math.max(...ents.map((e) => e.consecutiveFailures)),
      entityIds: distinctLeafIds,
      entityCount: distinctEntities.length,
      logPaths: [...new Set(histories.map((h) => h.logPath).filter(Boolean))].sort(),
      excerpts: [...new Set(histories.filter((h) => !h.ok).map((h) => h.excerpt).filter(Boolean))].slice(0, 5),
    });
  }
  return escalations.sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}

// Fold provider availability into synthetic-entity passes, shaped exactly like a
// consolidate report's `passes` so updateEntityState consumes it unchanged.
export function synthesizeProviderEntities({ compileExit = null, compileOk = null, compileError = "", report = null } = {}) {
  const passes = {};
  if (compileExit === EX_UNAVAILABLE) {
    // Tail-first excerpt so ENOENT vs timeout vs auth produce DIFFERENT
    // signatures (different root causes, different operator fixes).
    const raw = collapse(compileError) || `compile providers unavailable (exit ${EX_UNAVAILABLE})`;
    const lastIdx = raw.indexOf("; last: ");
    const excerpt = lastIdx >= 0 ? `${raw.slice(lastIdx + "; last: ".length)} <= ${raw.slice(0, lastIdx)}` : raw;
    passes[SYNTH_COMPILE_PASS] = {
      name: SYNTH_COMPILE_PASS,
      entities: [],
      failures: [{ id: SYNTH_COMPILE_ENTITY, kind: "system-provider", action: "promote", ok: false, excerpt }],
    };
  } else if (compileOk === true) {
    passes[SYNTH_COMPILE_PASS] = {
      name: SYNTH_COMPILE_PASS,
      entities: [{ id: SYNTH_COMPILE_ENTITY, kind: "system-provider", action: "promote", ok: true }],
      failures: [],
    };
  }
  const realConsolidate = Boolean(report && !report.skipped && !report.dryRun);
  if (realConsolidate && report.llmRequested === true) {
    // ./memory surfaces a mid-run outage as llm:false and/or llmInterrupted:true.
    const llmSkipped = report.llm === false || report.llmInterrupted === true;
    // Distinguish "never ran" (llm=false from the start) from "died mid-run"
    // (llmInterrupted) so the excerpt is accurate and the two open distinct
    // episodes (different operator signals).
    const excerpt = report.llmInterrupted === true
      ? "consolidate: LLM provider unavailable MID-RUN (passes interrupted) llmRequested=true llmInterrupted=true"
      : "consolidate: LLM passes skipped (provider unavailable) llmRequested=true llm=false";
    passes[SYNTH_CONSOLIDATE_PASS] = llmSkipped
      ? {
          name: SYNTH_CONSOLIDATE_PASS,
          entities: [],
          failures: [{ id: SYNTH_CONSOLIDATE_ENTITY, kind: "system-provider", action: "llm-pass", ok: false, excerpt }],
        }
      : {
          name: SYNTH_CONSOLIDATE_PASS,
          entities: [{ id: SYNTH_CONSOLIDATE_ENTITY, kind: "system-provider", action: "llm-pass", ok: true }],
          failures: [],
        };
  }
  return passes;
}

// ─── issue reports (deterministic skeletons) ───────────────────────────────

export function readIssuesIndex({ issuesIndexPath = ISSUES_INDEX_PATH, issuesDir = ISSUES_DIR, dataDir = MEMORY_DATA_DIR } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(issuesIndexPath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.signatures && typeof parsed.signatures === "object") {
      return parsed;
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      process.stderr.write(`[cron-job] issues index unreadable (${err?.message || err}); rebuilding from issues/ tree\n`);
      return rebuildIssuesIndex({ issuesDir, dataDir });
    }
  }
  return { version: 1, signatures: {} };
}

function rebuildIssuesIndex({ issuesDir = ISSUES_DIR, dataDir = MEMORY_DATA_DIR } = {}) {
  const idx = { version: 1, signatures: {} };
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const head = fs.readFileSync(p, "utf8").slice(0, 2_000);
          const sig = /^signature:\s*(.+)$/m.exec(head)?.[1]?.trim();
          const version = Number(/^version:\s*(\d+)$/m.exec(head)?.[1] || 1);
          const status = /^status:\s*(\w+)/m.exec(head)?.[1] || "open";
          if (!sig) continue;
          const cur = idx.signatures[sig];
          if (!cur || version > cur.version) {
            idx.signatures[sig] = { version, path: path.relative(dataDir, p), status, occurrences: [] };
          }
        } catch {
          /* skip unreadable report */
        }
      }
    }
  };
  walk(issuesDir);
  return idx;
}

function writeIssuesIndex(idx, { issuesIndexPath = ISSUES_INDEX_PATH } = {}) {
  try {
    fs.mkdirSync(path.dirname(issuesIndexPath), { recursive: true }); // writeFileAtomic ENOENTs without the dir
    writeFileAtomic(issuesIndexPath, JSON.stringify(idx, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`[cron-job] failed to write issues index: ${err?.message || err}\n`);
  }
}

// The .md report is a pure RENDER of index-held state; the WHOLE document passes
// redact(): these reports are meant to be copied upstream and must never carry a
// secret.
function renderIssueReport(rec) {
  const e = rec.escalation;
  const lines = [
    "---",
    `status: ${rec.status}`,
    `signature: ${rec.signature}`,
    `version: ${rec.version}`,
    `reason: ${e.reason}`,
    `firstSeen: ${e.sinceTs || "unknown"}`,
    `lastSeen: ${e.lastTs || "unknown"}`,
    `attempts: ${e.attempts}`,
    ...(rec.resolvedAt ? [`resolvedAt: ${rec.resolvedAt}`] : []),
    "affectedEntityIds:",
    ...e.entityIds.map((id) => `  - ${collapse(id)}`),
    "logPaths:",
    ...e.logPaths.map((p) => `  - ${collapse(p)}`),
    "---",
    "",
    `# Consolidate escalation: ${collapse(rec.signature)}`,
    "",
    "Auto-generated skeleton: " +
      (e.reason === "recurring-bug"
        ? `the same error signature recurred across ${e.entityCount} distinct entities (likely a code bug; max ${e.attempts} consecutive attempt(s) on any one)`
        : `a maintenance action kept failing for the same entity across ${e.attempts} consecutive cron attempt(s)`) +
      ". Use it to draft a fix; an agent can deepen the analysis from the linked full logs on request.",
    "",
    "## Error excerpts (redacted)",
    ...(e.excerpts.length ? e.excerpts.map((x) => `- ${collapse(x)}`) : ["- (no excerpt captured)"]),
    "",
    "## Occurrences",
    ...rec.occurrences.map((o) => `- ${o.ts} attempts=${o.attempts} entities=${o.entityCount} ${o.logPath || "(no log)"}`),
    "",
    "## Affected entities",
    ...e.entityIds.map((id) => `- ${collapse(id)}`),
    "",
    "<!-- agent: deepen this analysis only on explicit user request; start from the logPaths above -->",
    "",
  ];
  return redact(lines.join("\n"));
}

export function writeIssueReports(escalations, state, now = new Date(), { issuesDir = ISSUES_DIR, issuesIndexPath = ISSUES_INDEX_PATH, dataDir = MEMORY_DATA_DIR } = {}) {
  const idx = readIssuesIndex({ issuesIndexPath, issuesDir, dataDir });
  const ts = now.toISOString();
  const touched = [];

  for (const esc of escalations) {
    let rec = idx.signatures[esc.signature];
    if (!rec || rec.status !== "open") {
      const version = (rec?.version || 0) + 1;
      const abs = path.join(issuesDir, dailyDatePath(now).split("/").join(path.sep), `${esc.signature}.${version}.md`);
      rec = { version, path: path.relative(dataDir, abs), status: "open", occurrences: [] };
      idx.signatures[esc.signature] = rec;
    }
    rec.signature = esc.signature;
    rec.escalation = esc;
    rec.occurrences.push({ ts, attempts: esc.attempts, entityCount: esc.entityCount, logPath: esc.logPaths.at(-1) || null });
    if (rec.occurrences.length > 50) rec.occurrences = rec.occurrences.slice(-50);
    const abs = path.join(dataDir, rec.path);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeFileAtomic(abs, renderIssueReport(rec));
      delete rec.unrendered;
      touched.push(rec.path);
    } catch (err) {
      rec.unrendered = true;
      process.stderr.write(`[cron-job] failed to write issue report ${rec.path}: ${err?.message || err}\n`);
    }
  }

  // Resolution: an open episode whose signature no longer has ANY tracked failing
  // entity flips to resolved in place (file kept).
  const liveSignatures = new Set(Object.values(state.entities || {}).map((e) => e.lastSignature).filter(Boolean));
  for (const [sig, rec] of Object.entries(idx.signatures)) {
    if (rec.status !== "open" || liveSignatures.has(sig)) continue;
    rec.status = "resolved";
    rec.resolvedAt = ts;
    if (rec.escalation) {
      try { writeFileAtomic(path.join(dataDir, rec.path), renderIssueReport(rec)); } catch { /* index still records it */ }
    }
    touched.push(rec.path);
  }

  writeIssuesIndex(idx, { issuesIndexPath });
  return { touched, openCount: Object.values(idx.signatures).filter((r) => r.status === "open").length };
}

export function openEscalationsFromIndex({ issuesIndexPath = ISSUES_INDEX_PATH, issuesDir = ISSUES_DIR, dataDir = MEMORY_DATA_DIR } = {}) {
  const idx = readIssuesIndex({ issuesIndexPath, issuesDir, dataDir });
  return Object.entries(idx.signatures)
    .filter(([, rec]) => rec.status === "open")
    .map(([signature, rec]) => ({
      signature,
      sinceTs: rec.escalation?.sinceTs || null,
      attempts: rec.escalation?.attempts ?? null,
      entityCount: rec.escalation?.entityCount ?? null,
      issuePath: rec.path,
      ...(rec.unrendered ? { unrendered: true } : {}),
    }))
    .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
}

// ─── runner ───────────────────────────────────────────────────────────────

export function runStep(scriptPath, args, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const timedOut = Boolean(r.error && (r.error.code === "ETIMEDOUT" || r.signal === "SIGTERM"));
  const detail = timedOut
    ? `step timed out after ${timeoutMs}ms (killed)`
    : r.error
      ? `spawn error: ${r.error.message || r.error.code || r.error}`
      : "";
  // Failure detail FIRST so the cap never truncates it away; REDACT the child
  // stderr (it is persisted + surfaced via cron_health).
  const stderr = redact([detail, String(r.stderr || "")].filter(Boolean).join("\n")).slice(0, STDERR_CAP_BYTES);
  return {
    ok: r.status === 0 && !r.error,
    exit: typeof r.status === "number" ? r.status : -1,
    timedOut,
    stderr,
    stdout: String(r.stdout || ""),
  };
}

// deps is injectable so the orchestration + escalation are unit-testable WITHOUT
// spawning real subprocesses, taking the shared lock, or writing live state.
//   deps.runStepFn / acquireLockFn / appendFn: step runner / lock / slim append
//   deps.statePaths: { entitiesPath, issuesIndexPath, issuesDir, cronLogsDir,
//                       dataDir } to redirect the self-healing artifacts at a tmp.
export async function runCronJob(deps = {}) {
  const runStepFn = deps.runStepFn || runStep;
  const sp = deps.statePaths || {};
  const appendFn =
    deps.appendFn ||
    ((entry) => appendAttempt(entry, { logPath: sp.attemptsLogPath || CONSOLIDATE_ATTEMPTS_LOG_PATH }));
  const acquireLockFn = deps.acquireLockFn || (() => {
    try { fs.mkdirSync(path.dirname(CRON_LOCK_PATH), { recursive: true }); } catch { /* best-effort */ }
    installLockReleaseHandlers(CRON_LOCK_PATH);
    return acquireLock(CRON_LOCK_PATH, { label: "cron-job" });
  });

  const start = new Date();
  const ts = start.toISOString();
  const dataDir = sp.dataDir || MEMORY_DATA_DIR;
  const fullLogAbs = fullLogPathFor(start, { cronLogsDir: sp.cronLogsDir || CRON_LOGS_DIR });
  // Relative to the EFFECTIVE data dir (honors statePaths.dataDir) so a redirected
  // test run gets a clean relative pointer, not a "../"-laden path.
  const logPathRel = path.relative(dataDir, fullLogAbs);
  const compileCli = path.join(MEMORY_DIR, "scripts", "compile.mjs");
  const consolidateCli = path.join(MEMORY_DIR, "scripts", "consolidate.mjs");

  const entry = { ts, kind: "cron-job", ok: false, durationMs: 0, compile: null, consolidate: null, error: null, escalations: 0, logPath: logPathRel };
  const full = { ts, kind: "cron-job", ok: false, durationMs: 0, compile: null, consolidate: null, escalations: [], error: null };

  let compileProvidersUnavailable = false;
  let compileErrorFull = "";
  let report = null;

  const cronLock = acquireLockFn();
  if (!cronLock.ok) {
    return { ...entry, ok: true, skipped: "overlap", durationMs: Date.now() - start.getTime() };
  }

  // Entity-level self-healing, recorded on EVERY finished tick (including the
  // early-return paths, so a compile failure streak is never lost). The synthetic
  // provider entities are judged whenever compile produced a result (compile runs
  // hourly); consolidate's real entities only count on a REAL run.
  const recordSelfHealing = () => {
    try {
      const realConsolidate = Boolean(report && !report.skipped && !report.dryRun);
      const synthetic = synthesizeProviderEntities({
        compileExit: entry.compile?.exit,
        compileOk: entry.compile?.ok,
        compileError: compileErrorFull,
        report,
      });
      const passes = { ...(realConsolidate ? report.passes || {} : {}), ...synthetic };
      if (Object.keys(passes).length === 0) return;
      const escalateAfter = escalateAfterSafe();
      const state = readEntityState({ entitiesPath: sp.entitiesPath });
      updateEntityState(state, { passes }, { ts, logPath: logPathRel, escalateAfter });
      let escalations = evaluateEscalations(state, { escalateAfter });
      if (!realConsolidate) {
        // Off-cycle tick (not-due / compile-69 short-circuit): only synthetic
        // entities were attempted. Limit occurrence appends to THEIR signatures
        // so a pending consolidate episode doesn't accrue hourly noise.
        const syntheticPasses = new Set(Object.keys(synthetic));
        const touchedSigs = new Set(
          Object.values(state.entities || {})
            .filter((e) => syntheticPasses.has(e.pass))
            .map((e) => e.lastSignature)
            .filter(Boolean),
        );
        escalations = escalations.filter((e) => touchedSigs.has(e.signature));
      }
      const issues = writeIssueReports(escalations, state, start, {
        issuesDir: sp.issuesDir, issuesIndexPath: sp.issuesIndexPath, dataDir,
      });
      writeEntityState(state, { entitiesPath: sp.entitiesPath });
      entry.escalations = issues.openCount;
      full.escalations = escalations;
    } catch (err) {
      process.stderr.write(`[cron-job] self-healing bookkeeping failed: ${err?.message || err}\n`);
    }
  };

  const finish = () => {
    recordSelfHealing();
    entry.durationMs = Date.now() - start.getTime();
    full.ok = entry.ok;
    full.error = entry.error;
    full.durationMs = entry.durationMs;
    writeFullLog(fullLogAbs, full);
    appendFn(entry);
    pruneFullLogs(start, { cronLogsDir: sp.cronLogsDir || CRON_LOGS_DIR });
    return entry;
  };

  try {
    // 1. compile (per-UTC-day state; cheap no-op on re-run). Exit 69 = providers
    // unavailable: a FAILED, retryable tick that short-circuits consolidate.
    try {
      const r = runStepFn(compileCli, []);
      entry.compile = { ok: r.ok, exit: r.exit, stderr: r.stderr.slice(0, 500) };
      full.compile = { ok: r.ok, exit: r.exit, stderr: r.stderr, stdout: redact(String(r.stdout || "")).slice(0, STDOUT_CAP_BYTES) };
      if (!r.ok) {
        compileProvidersUnavailable = r.exit === EX_UNAVAILABLE;
        // Uncapped (collapsed) for the synthetic-entity excerpt; r.stderr is
        // already redacted by runStep.
        compileErrorFull = collapse(r.stderr);
        entry.error = compileProvidersUnavailable
          ? `compile: providers unavailable (exit 69); promotion deferred, will retry: ${r.stderr.slice(0, 240)}`
          : `compile exit ${r.exit}: ${r.stderr.slice(0, 300)}`;
        return finish();
      }
    } catch (err) {
      entry.error = `compile threw: ${collapse(redact(err?.message || String(err))).slice(0, 200)}`;
      return finish();
    }

    // 2. consolidate --if-due --json (self-throttled by --if-due).
    try {
      const r = runStepFn(consolidateCli, ["--if-due", "--json"]);
      entry.consolidate = { ok: r.ok, exit: r.exit, stderr: r.stderr.slice(0, 500) };
      full.consolidate = { ok: r.ok, exit: r.exit, stderr: r.stderr, report: null };
      if (!r.ok) {
        entry.error = `consolidate exit ${r.exit}: ${r.stderr.slice(0, 300)}`;
        return finish();
      }
      try {
        report = JSON.parse(r.stdout);
      } catch {
        entry.error = `consolidate exited 0 but produced unparseable --json stdout: ${redact(String(r.stdout)).slice(0, 200)}`;
        return finish();
      }
      full.consolidate.report = report;
      entry.consolidate.summary = {
        ok: report.ok, skipped: report.skipped || null, dryRun: Boolean(report.dryRun),
        totals: report.totals || null, workingSetSize: report.workingSetSize ?? null,
        llm: report.llm ?? null, llmRequested: report.llmRequested ?? null, llmInterrupted: report.llmInterrupted || false,
      };
      const errs = Number(report?.totals?.errors) || 0;
      if (report && report.ok === false) {
        entry.error = `consolidate not ok: ${report.error || "unknown"}`;
      } else if (errs > 0) {
        entry.error = `consolidate completed with ${errs} error(s)`;
      } else if (report && report.llmInterrupted) {
        entry.error = "consolidate: LLM provider unavailable mid-run; LLM passes incomplete (will retry next run)";
      }
    } catch (err) {
      entry.error = `consolidate threw: ${collapse(redact(err?.message || String(err))).slice(0, 200)}`;
      return finish();
    }

    entry.ok = !entry.error;
    return finish();
  } finally {
    try { cronLock.release && cronLock.release(); } catch { /* best-effort */ }
  }
}

// ─── health ───────────────────────────────────────────────────────────────
//
// Does the resolved data dir actually look like a memory install? A real one,
// even brand-new, has the dir AND at least one marker that bootstrap.sh writes up
// front: settings/.env (the canonical env file) or state/ (created by bootstrap so
// it can be bind-mounted read-only into the container, before any cron tick runs).
// A MIS-SET MEMORY_DATA_DIR (a typo/stale path that is absent, or an unrelated
// existing dir like $HOME with neither marker) must NOT be mistaken for a "fresh,
// healthy" install: readAttempts + openEscalationsFromIndex both ENOENT to empty
// there, so without this guard cronHealth would return healthy:true off a
// wrong-path empty read. This is the inverse of that footgun.
function installLooksReal(dataDir) {
  // Type-check the markers, not just existence: a path named "state" that is a
  // FILE (or "settings/.env" that is a DIRECTORY) would pass an existsSync check
  // but make later reads under state/ throw ENOTDIR, which the readers swallow as
  // empty -> the very false-healthy we are guarding against. So require dataDir
  // and state/ to be directories and settings/.env to be a file.
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (!dataDir || !isDir(dataDir)) return false;
  return isFile(path.join(dataDir, "settings", ".env")) || isDir(path.join(dataDir, "state"));
}

// Unhealthy iff the data dir is mis-set (cannot be assessed), the most-recent
// attempt errored with no later success, OR at least one escalation episode is
// still open. A failure that later resolved stays silent.
export function cronHealth({ limit = 20, logPath = CONSOLIDATE_ATTEMPTS_LOG_PATH, issuesIndexPath = ISSUES_INDEX_PATH, issuesDir = ISSUES_DIR, dataDir = MEMORY_DATA_DIR } = {}) {
  // Refuse to report health off a mis-set MEMORY_DATA_DIR. ok:false signals the
  // check itself could not run against a real install; healthy:false ensures any
  // monitor gating on `healthy` alarms rather than seeing a false green.
  if (!installLooksReal(dataDir)) {
    return {
      ok: false,
      healthy: false,
      summary: `cannot assess cron health: MEMORY_DATA_DIR (${dataDir}) is absent or not a memory install dir (mis-set MEMORY_DATA_DIR?)`.slice(0, 200),
      lastAttempt: null,
      recent: [],
      escalations: [],
    };
  }

  const all = readAttempts({ limit: Math.max(attemptsKeepSafe(), 200), logPath });
  const escalations = openEscalationsFromIndex({ issuesIndexPath, issuesDir });
  const lastAttempt = all.length ? all[all.length - 1] : null;

  // `recent` is part of the documented shape on EVERY path (consistent for callers).
  const recent = all.slice(-limit);

  if (!lastAttempt && escalations.length === 0) {
    return { ok: true, healthy: true, summary: "no cron-job attempts logged yet (cron not yet scheduled or system fresh)", lastAttempt: null, recent, escalations };
  }

  if (escalations.length > 0) {
    const newest = escalations.reduce((a, b) => ((a.sinceTs || "") >= (b.sinceTs || "") ? a : b));
    const where = newest.unrendered
      ? `report write FAILED (signature ${newest.signature}; see cron stderr)`
      : `newest report ${newest.issuePath}`;
    return { ok: true, healthy: false, summary: `UNRESOLVED: ${escalations.length} open escalation(s); ${where}`.slice(0, 200), lastAttempt, recent, escalations };
  }

  if (lastAttempt.ok === false) {
    return { ok: true, healthy: false, summary: `UNRESOLVED FAILURE at ${lastAttempt.ts}: ${collapse(lastAttempt.error || "<no detail>").slice(0, 120)}`, lastAttempt, recent, escalations };
  }

  let lastFailureAt = null;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].ok === false) { lastFailureAt = all[i].ts; break; }
  }
  return { ok: true, healthy: true, summary: `healthy; last cron-job ok at ${lastAttempt.ts}`, lastAttempt, lastSuccessAt: lastAttempt.ts, ...(lastFailureAt ? { lastFailureAt } : {}), recent: all.slice(-limit), escalations };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("cron-health") || args.includes("--health")) {
    const result = cronHealth();
    process.stdout.write(JSON.stringify(result) + "\n");
    // Exit non-zero when not healthy so a shell monitor (`... --health || alert`)
    // cannot be silently fooled the way the JSON verdict could. Covers a mis-set
    // MEMORY_DATA_DIR (ok:false), an open escalation, and an unresolved failure.
    // Set exitCode + return (do NOT process.exit) so Node flushes stdout before
    // exiting: process.exit can truncate a piped JSON write mid-stream.
    process.exitCode = result.healthy ? 0 : 1;
    return;
  }
  const entry = await runCronJob();
  process.exit(entry.ok ? 0 : 1);
}

const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  await main();
}
