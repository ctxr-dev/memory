// Cron-driven maintenance runner: compile + consolidate --if-due.
//
// bootstrap.sh --schedule daily installs an HOURLY cron (launchd on macOS,
// crontab on Linux) that invokes this. The heavy work is bounded by each step's
// own throttle:
//   - compile.mjs's per-UTC-day state (.compile-state.json)
//   - consolidate.mjs's --if-due rolling window (MEMORY_CONSOLIDATE_INTERVAL_DAYS)
// So hourly attempts do real work at most once per day. Each attempt appends a
// JSONL entry to state/.consolidate-attempts.log; cron_health (MCP) and the
// cron-health subcommand read it to surface an unresolved failure.
//
// Self-healing: a failed attempt is NOT silently dropped — it stays in the log
// until a later attempt succeeds. Logging never throws; every step failure is
// captured into the entry, not propagated.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { MEMORY_DIR, MEMORY_DATA_DIR, CONSOLIDATE_ATTEMPTS_LOG_PATH, envInt } from "./lib/env.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lib/lock.mjs";

const MAX_LOG_LINES = 200;
const STDERR_CAP_BYTES = 2000;
// Bounded per-step timeout. Without it, a hung compile/consolidate (e.g. a stuck
// `docker exec` to the bridge) would let cron-job run forever holding the cron
// lock, starving every future hourly attempt and leaving cron_health with a
// stale lastAttempt. On timeout spawnSync kills the child (SIGTERM) and the step
// is recorded as a failure. Override via MEMORY_CRON_STEP_TIMEOUT_MS (default
// 30m). Read through envInt -> envValue so the canonical settings/.env applies
// (cron/launchd run with a minimal process env that would not carry the var).
const STEP_TIMEOUT_MS = envInt("MEMORY_CRON_STEP_TIMEOUT_MS", 30 * 60 * 1000);
// Serialises cron-job runs so two overlapping invocations (launchd/cron can
// start a new run before the previous finishes) never race appendAttempt's
// read-rewrite log truncation.
const CRON_LOCK_PATH = path.join(MEMORY_DATA_DIR, "state", ".cron-job.lock");

function appendAttempt(entry) {
  try {
    fs.mkdirSync(path.dirname(CONSOLIDATE_ATTEMPTS_LOG_PATH), { recursive: true });
    fs.appendFileSync(CONSOLIDATE_ATTEMPTS_LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    process.stderr.write(`[cron-job] failed to append attempt log: ${err?.message || err}\n`);
    return;
  }
  try {
    const lines = fs.readFileSync(CONSOLIDATE_ATTEMPTS_LOG_PATH, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      fs.writeFileSync(CONSOLIDATE_ATTEMPTS_LOG_PATH, lines.slice(-MAX_LOG_LINES).join("\n") + "\n");
    }
  } catch {
    /* best-effort */
  }
}

export function readAttempts({ limit = 50 } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(CONSOLIDATE_ATTEMPTS_LOG_PATH, "utf8");
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

export function cronHealth({ limit = 20 } = {}) {
  const all = readAttempts({ limit: MAX_LOG_LINES });
  if (all.length === 0) {
    return { ok: true, healthy: true, summary: "no cron-job attempts logged yet (cron not yet scheduled or system fresh)", lastAttempt: null };
  }
  const last = all[all.length - 1];
  if (last.ok === false) {
    return { ok: true, healthy: false, summary: `UNRESOLVED FAILURE at ${last.ts}: ${String(last.error || "").slice(0, 200)}`, lastAttempt: last, recent: all.slice(-limit) };
  }
  let lastFailureAt = null;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i].ok === false) {
      lastFailureAt = all[i].ts;
      break;
    }
  }
  return { ok: true, healthy: true, summary: `healthy; last cron-job ok at ${last.ts}`, lastAttempt: last, lastSuccessAt: last.ts, ...(lastFailureAt ? { lastFailureAt } : {}), recent: all.slice(-limit) };
}

export function runStep(scriptPath, args, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  // spawnSync sets `error` (code ETIMEDOUT) and kills with killSignal on timeout,
  // and also on spawn failure (e.g. ENOENT). Either way the step is NOT ok.
  const timedOut = Boolean(r.error && (r.error.code === "ETIMEDOUT" || r.signal === "SIGTERM"));
  const detail = timedOut
    ? `step timed out after ${timeoutMs}ms (killed)`
    : r.error
      ? `spawn error: ${r.error.message || r.error.code || r.error}`
      : "";
  // Put the failure detail FIRST so the cap never truncates it away.
  const stderr = [detail, String(r.stderr || "")].filter(Boolean).join("\n").slice(0, STDERR_CAP_BYTES);
  return {
    ok: r.status === 0 && !r.error,
    exit: typeof r.status === "number" ? r.status : -1,
    timedOut,
    stderr,
    stdout: String(r.stdout || ""),
  };
}

export async function runCronJob() {
  const start = Date.now();
  const entry = { ts: new Date(start).toISOString(), kind: "cron-job", ok: false, durationMs: 0, compile: null, consolidate: null, error: null };
  const compileCli = path.join(MEMORY_DIR, "scripts", "compile.mjs");
  const consolidateCli = path.join(MEMORY_DIR, "scripts", "consolidate.mjs");

  // Skip (don't append) if another cron-job run holds the lock: it logs its own
  // attempt; appending from a second instance would race the log truncation.
  // Ensure the state dir exists first (cron-job can run before bootstrap creates
  // it, or after a manual cleanup) so the atomic-create lock does not ENOENT.
  try {
    fs.mkdirSync(path.dirname(CRON_LOCK_PATH), { recursive: true });
  } catch {
    /* best-effort; acquireLock surfaces a real failure */
  }
  installLockReleaseHandlers(CRON_LOCK_PATH);
  const cronLock = acquireLock(CRON_LOCK_PATH, { label: "cron-job" });
  if (!cronLock.ok) {
    return { ...entry, ok: true, skipped: "overlap", durationMs: Date.now() - start };
  }

  try {
    // 1. compile (per-UTC-day state; cheap no-op on re-run).
    try {
      const r = runStep(compileCli, []);
      entry.compile = { ok: r.ok, exit: r.exit, stderr: r.stderr.slice(0, 500) };
      if (!r.ok) {
        entry.error = `compile exit ${r.exit}: ${r.stderr.slice(0, 300)}`;
        entry.durationMs = Date.now() - start;
        appendAttempt(entry);
        return entry;
      }
    } catch (err) {
      entry.error = `compile threw: ${err?.message || err}`;
      entry.durationMs = Date.now() - start;
      appendAttempt(entry);
      return entry;
    }

    // 2. consolidate --if-due --json (self-throttles to once per cadence).
    try {
      const r = runStep(consolidateCli, ["--if-due", "--json"]);
      entry.consolidate = { ok: r.ok, exit: r.exit, stderr: r.stderr.slice(0, 500) };
      if (r.ok) {
        try {
          const body = JSON.parse(r.stdout);
          entry.consolidate.summary = { ok: body.ok, skipped: body.skipped || null, dryRun: body.dryRun || false, totals: body.totals || null, workingSetSize: body.workingSetSize ?? null };
          // A zero exit code is not enough: consolidate can exit 0 while
          // reporting ok:false or per-doc errors. Surface those so cron-health
          // does not mask them as a clean run.
          const errs = Number(body?.totals?.errors) || 0;
          if (body && body.ok === false) {
            entry.error = `consolidate not ok: ${body.error || "unknown"}`;
          } else if (errs > 0) {
            entry.error = `consolidate completed with ${errs} error(s)`;
          }
        } catch {
          // Exit 0 but unparseable --json stdout means something is wrong
          // (stray stdout logging, partial output); treat it as an error so
          // cron-health does not record a misleading clean run.
          entry.error = `consolidate exited 0 but produced unparseable --json stdout: ${String(r.stdout).slice(0, 200)}`;
        }
      } else {
        entry.error = `consolidate exit ${r.exit}: ${r.stderr.slice(0, 300)}`;
        entry.durationMs = Date.now() - start;
        appendAttempt(entry);
        return entry;
      }
    } catch (err) {
      entry.error = `consolidate threw: ${err?.message || err}`;
      entry.durationMs = Date.now() - start;
      appendAttempt(entry);
      return entry;
    }

    // ok unless a non-fatal consolidate error was surfaced above.
    entry.ok = !entry.error;
    entry.durationMs = Date.now() - start;
    appendAttempt(entry);
    return entry;
  } finally {
    try {
      cronLock.release && cronLock.release();
    } catch {
      /* best-effort */
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("cron-health") || args.includes("--health")) {
    process.stdout.write(JSON.stringify(cronHealth()) + "\n");
    process.exit(0);
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
