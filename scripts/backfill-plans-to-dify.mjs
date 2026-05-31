// Backfill historical Claude Code plans into the Dify plans dataset.
//
// Context: prior to the W18z launcher fix, the ExitPlanMode hook
// silently no-op'd in real Claude Code sessions because $CLAUDE_PROJECT_DIR
// was not propagated to the hook subprocess. Months of approved plans
// accumulated under ~/.claude/plans/*.md but never reached Dify, so
// they are invisible to recall_lessons / search_memory in future
// sessions. This script reads every plan file in the local plans dir,
// fences each body with the SAME boundary the live hook uses, and
// pushes them to the plans dataset via the existing saveDocument
// bridge (whose name-keyed upsert handles dedup deterministically).
//
// Idempotent: a second run with the same inputs produces no new
// chunks because each doc name is derived from the slugified plan
// title, and Dify's create-by-text endpoint dedupes on name when
// invoked through saveDocument (mirroring the live hook's contract).
//
// Usage:
//   node scripts/backfill-plans-to-dify.mjs               # do it
//   node scripts/backfill-plans-to-dify.mjs --dry-run     # show plan only
//   node scripts/backfill-plans-to-dify.mjs --plans-dir=<path>
//                                                         # override source dir
//   node scripts/backfill-plans-to-dify.mjs --limit=10    # cap doc count
//
// Exit codes:
//   0  success (all candidates pushed or dry-run completed)
//   2  preflight failure (bridge unavailable, plans slot unbound)
//   3  user error (--plans-dir does not exist, etc.)
//
// Why this lives in upstream `memory/` rather than each consumer:
// every workspace using ctxr-dev/memory had the same broken hook for
// the same duration; shipping the backfill upstream means a single
// `npx ...` invocation (or local `node scripts/backfill-...`) recovers
// the history for any project that adopts the v1 hook fix.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { slugify } from "./lib/slug.mjs";
import { saveDocument, DifyBridgeUnavailable } from "./lib/dify-write.mjs";
import { envValue, slotEnvKey } from "./lib/env.mjs";
import { redact } from "./lib/redact.mjs";
import {
  extractTitle,
  fencePlanBody,
} from "./hooks/exit-plan-mode.mjs";

const PLANS_SLOT = "plans";
const DEFAULT_PLANS_DIR = path.join(os.homedir(), ".claude", "plans");
// Same cap as the live hook (exit-plan-mode.mjs DEFAULT_MAX_PLAN_BYTES).
const MAX_PLAN_BYTES = 256_000;

class BackfillError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const opts = { dryRun: false, plansDir: DEFAULT_PLANS_DIR, limit: Infinity };
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--plans-dir=")) opts.plansDir = arg.slice("--plans-dir=".length);
    else if (arg.startsWith("--limit=")) {
      const n = Number.parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new BackfillError(`invalid --limit: ${arg}`, 3);
      }
      opts.limit = n;
    } else {
      throw new BackfillError(`unknown arg: ${arg}`, 3);
    }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`Backfill Claude Code plans into the Dify plans dataset.

Usage:
  node scripts/backfill-plans-to-dify.mjs [--dry-run] [--plans-dir=<path>] [--limit=<n>]

Options:
  --dry-run, -n          Print what would be pushed; do not write to Dify.
  --plans-dir=<path>     Source dir (default: ~/.claude/plans).
  --limit=<n>            Cap the number of plans pushed.
  --help, -h             This help.

Exit codes:
  0  success
  2  bridge/preflight failure
  3  user error
`);
}

// Exported for tests. Reads every *.md under plansDir, sorts by mtime
// ascending (oldest first, so the most recent plan ends up as the
// "newest" in any timeline view that orders by ingestion time), and
// returns a structured list of candidate docs.
export function collectCandidates(plansDir, { maxBytes = MAX_PLAN_BYTES } = {}) {
  if (!fs.existsSync(plansDir)) {
    throw new BackfillError(`plans dir does not exist: ${plansDir}`, 3);
  }
  if (!fs.statSync(plansDir).isDirectory()) {
    throw new BackfillError(`not a directory: ${plansDir}`, 3);
  }

  const files = fs.readdirSync(plansDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(plansDir, f))
    .map((full) => ({ full, mtime: fs.statSync(full).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  const candidates = [];
  const skips = [];
  for (const { full } of files) {
    const raw = fs.readFileSync(full, "utf8");
    const redacted = redact(raw).trim();
    if (!redacted) {
      skips.push({ path: full, reason: "empty after redaction" });
      continue;
    }
    if (Buffer.byteLength(redacted, "utf8") > maxBytes) {
      skips.push({ path: full, reason: `body >${maxBytes} bytes` });
      continue;
    }
    const title = extractTitle(redacted);
    const slug = slugify(title);
    candidates.push({
      sourcePath: full,
      name: `plan-${slug}.md`,
      title,
      text: fencePlanBody(redacted),
      sizeBytes: Buffer.byteLength(redacted, "utf8"),
    });
  }
  return { candidates, skips };
}

async function preflight() {
  const envKey = slotEnvKey(PLANS_SLOT);
  const boundId = envValue(envKey, "");
  if (!boundId) {
    throw new BackfillError(
      `plans slot not bound; ${envKey} is empty in ./.memory/settings/.env. ` +
      `Run ./.memory/src/scripts/dify-setup.sh to bind it.`,
      2,
    );
  }
}

async function pushOne(candidate, { dryRun }) {
  if (dryRun) {
    return { status: "dry-run", note: `would push ${candidate.name} (${candidate.sizeBytes} B)` };
  }
  try {
    const result = await saveDocument({
      name: candidate.name,
      text: candidate.text,
      datasetId: PLANS_SLOT,
      metadata: { atom_type: "plan", task_type: "planning" },
    });
    const notes = [];
    if (result?.metadataError) notes.push(`metadata error: ${result.metadataError}`);
    if (result?.metadataResult?.warning) notes.push(`metadata warning: ${result.metadataResult.warning}`);
    return { status: "saved", note: notes.length ? notes.join("; ") : "" };
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) {
      throw new BackfillError(`bridge unavailable while pushing ${candidate.name}: ${err.message}`, 2);
    }
    throw err;
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }

  const { candidates, skips } = collectCandidates(opts.plansDir);
  if (skips.length > 0) {
    process.stderr.write(`skipped ${skips.length} file(s):\n`);
    for (const s of skips) process.stderr.write(`  ${s.path}: ${s.reason}\n`);
  }
  if (candidates.length === 0) {
    process.stdout.write(`no plans to push under ${opts.plansDir}\n`);
    return 0;
  }

  if (!opts.dryRun) {
    await preflight();
  }

  const slice = candidates.slice(0, opts.limit);
  process.stdout.write(`backfilling ${slice.length} plan(s) into Dify dataset "${PLANS_SLOT}":\n`);
  let okCount = 0;
  let failCount = 0;
  for (const c of slice) {
    try {
      const res = await pushOne(c, opts);
      const tail = res.note ? ` (${res.note})` : "";
      process.stdout.write(`  ${res.status}: ${c.name}${tail}\n`);
      if (res.status === "saved" || res.status === "dry-run") okCount += 1;
      else failCount += 1;
    } catch (err) {
      failCount += 1;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  failed: ${c.name}: ${msg}\n`);
      if (err instanceof BackfillError) throw err; // hard preflight; stop
    }
  }
  process.stdout.write(`done. ok=${okCount}, fail=${failCount}, candidates=${candidates.length}\n`);
  return failCount === 0 ? 0 : 1;
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
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`backfill-plans-to-dify: ${msg}\n`);
      process.exit(err instanceof BackfillError ? err.exitCode : 1);
    });
}

// Exported for tests.
export { BackfillError, parseArgs, preflight, pushOne };
