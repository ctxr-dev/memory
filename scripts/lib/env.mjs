import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MEMORY_DIR = path.resolve(here, "../..");
// Resolve the project root from the clone location, mirroring scripts/lib.sh.
// Installed layout (<project>/.memory/src) -> project root is two levels up;
// a bare repo checkout or a legacy <project>/memory install -> one level up.
// Detect "src" under a ".memory" parent and pick the matching depth so
// WORKSPACE_DIR is correct for fresh installs, legacy installs, and repo-dev
// workflows alike.
const inMemorySrc =
  path.basename(MEMORY_DIR) === "src" && path.basename(path.dirname(MEMORY_DIR)) === ".memory";
export const WORKSPACE_DIR = path.resolve(MEMORY_DIR, inMemorySrc ? "../.." : "..");
// Canonical env file lives under the durable, gitignored data dir
// (./.memory/settings/.env), mirroring scripts/lib.sh. Resolved from an
// exported MEMORY_DATA_DIR or the default; the clone-root .env.example
// ($MEMORY_DIR/.env.example) is the template, not a runtime read.
export const MEMORY_DATA_DIR =
  process.env.MEMORY_DATA_DIR && process.env.MEMORY_DATA_DIR !== ""
    ? process.env.MEMORY_DATA_DIR
    : path.join(WORKSPACE_DIR, ".memory");
export const ENV_PATH = path.join(MEMORY_DATA_DIR, "settings", ".env");
export const COMPILE_STATE_PATH = path.join(MEMORY_DIR, ".compile-state.json");
export const COMPILE_LOCK_PATH = path.join(MEMORY_DIR, ".compile.lock");
export const PROMPTS_DIR = path.join(MEMORY_DIR, "prompts");

// Durable cron/consolidate state lives under the gitignored data dir's
// `state/` folder (NOT MEMORY_DIR/src, which is the read-only mounted bridge
// source). compose.mcp.yaml mounts this folder read-only into the container so
// the cron_health MCP tool can read the attempts log written host-side by the
// cron. Both the dev clone (./memory) and the installed clone (.memory/src)
// resolve MEMORY_DATA_DIR to the same <workspace>/.memory, so they share one
// canonical state dir per workspace.
export const STATE_DIR = path.join(MEMORY_DATA_DIR, "state");
export const CONSOLIDATE_STATE_PATH = path.join(STATE_DIR, ".consolidate-state.json");
export const CONSOLIDATE_ATTEMPTS_LOG_PATH = path.join(STATE_DIR, ".consolidate-attempts.log");

// Parse one .env value. Deliberately small (NOT a full dotenv parser): it
// trims, honours a simple pair of surrounding single or double quotes (the
// content from the first quote to the next matching quote is taken literally,
// including a '#'; escaped quotes / backslashes are NOT handled, which is fine
// for the simple values this project stores), and otherwise drops an inline
// "# comment" (a '#' at the start, or preceded by whitespace). Without this,
// the inline comments shipped in .env.example (e.g.
// `DIFY_FLUSH_DATASET=daily   # flush.mjs writes ...`) leak into the value, so
// the dataset name becomes "daily   # ..." and slot resolution (and every
// other consumer) silently reads a polluted string.
export function parseEnvValue(raw) {
  let v = String(raw ?? "").trim();
  if (!v) return "";
  // Quoted value: return the literal inside the first matching quote pair and
  // ignore anything after the closing quote (e.g. a trailing inline comment,
  // `"value" # note`). A '#' inside the quotes is kept.
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end !== -1) return v.slice(1, end);
    // Unterminated quote (malformed): return the trimmed value literally rather
    // than guessing, so a stray '#' inside it is not mistaken for a comment.
    return v;
  }
  if (v[0] === "#") return "";
  // Unquoted: a '#' preceded by whitespace starts an inline comment.
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash);
  return v.trim();
}

export function readEnvFile(file = ENV_PATH) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = parseEnvValue(line.slice(i + 1));
  }
  return out;
}

export function envValue(name, fallback = "") {
  if (process.env[name] != null && process.env[name] !== "") return process.env[name];
  const file = readEnvFile();
  return file[name] ?? fallback;
}

export function envInt(name, fallback) {
  const raw = envValue(name, "");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Float reader for the 0..1 similarity / score thresholds. Returns the parsed
// value when finite and strictly positive, else the fallback. (Thresholds are
// always > 0; a 0 or negative value is treated as "unset, use default" rather
// than "match everything", which would archive aggressively.)
export function envFloat(name, fallback) {
  const raw = envValue(name, "");
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Boolean reader. Only the exact string "true"/"false" (case-insensitive)
// flips the value; anything else (unset, "", garbage) returns the fallback.
// Mirrors the `=== "true"` convention already used for MEMORY_COMPILE_QUALITY_STRICT.
export function envBool(name, fallback) {
  const raw = String(envValue(name, "")).trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

// Maximum body length for typed atoms, both at flush-time validation and at
// compile-time prompt rendering. Configurable via MEMORY_ATOM_BODY_MAX_CHARS;
// default 700 to fit a structured atom (rule + Why + How to apply) without
// flooding retrieval. Both flush.mjs:validateAtoms and prompts/compile.md
// read this value via envInt — keep the two ends in lock-step.
export const ATOM_BODY_MAX_CHARS_DEFAULT = 700;
export function atomBodyMaxChars() {
  return envInt("MEMORY_ATOM_BODY_MAX_CHARS", ATOM_BODY_MAX_CHARS_DEFAULT);
}

// Canonical env-var name for a dataset slot binding. Mirrors the tokeniser
// used by dify-setup.sh (lowercase + hyphen -> uppercase + underscore) so a
// slot called "my-runbooks" maps to DIFY_DATASET_MY_RUNBOOKS_ID, not
// DIFY_DATASET_MY-RUNBOOKS_ID. Single source of truth, used by every hook
// that does host-side slot-binding preflight.
export function slotEnvKey(slot) {
  const tag = String(slot || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `DIFY_DATASET_${tag}_ID`;
}

// ─── consolidate orchestrator knobs ──────────────────────────────────────────
// All env-overridable; defaults documented in .env.example. Numeric readers
// reuse envInt/envFloat (positive-or-fallback), so a blank or garbage value
// silently falls back rather than disabling a pass.

// Rolling-window cadence for the `--if-due` throttle: consolidate does heavy
// work at most once per this many days (the hourly cron attempts up to 24x).
export const CONSOLIDATE_INTERVAL_DAYS_DEFAULT = 1;
export function consolidateIntervalDays() {
  return envInt("MEMORY_CONSOLIDATE_INTERVAL_DAYS", CONSOLIDATE_INTERVAL_DAYS_DEFAULT);
}

// Dify hybrid score (NOT raw cosine) at/above which two docs are merge
// candidates in the similarity pass. Higher = stricter (fewer merges).
export function consolidateSimilarityThreshold() {
  return envFloat("MEMORY_CONSOLIDATE_SIMILARITY_THRESHOLD", 0.88);
}

// Coarser score floor for the per-doc cluster lookup that feeds the
// LLM-refresh prompt (wants surrounding context, not just near-duplicates).
export function consolidateClusterScoreThreshold() {
  return envFloat("MEMORY_CONSOLIDATE_CLUSTER_SCORE_THRESHOLD", 0.5);
}

// Top-K members fetched per cluster lookup.
export function consolidateClusterTopK() {
  return envInt("MEMORY_CONSOLIDATE_CLUSTER_TOP_K", 12);
}

// A doc whose last activity (max of last_recalled_at, created_at) is older than
// this many months is flagged stale (then refreshed/archived by the LLM pass).
export function consolidateStaleAfterMonths() {
  return envInt("MEMORY_CONSOLIDATE_STALE_AFTER_MONTHS", 6);
}

// Per-run cap on LLM semantic-refresh calls (bounds token cost + write volume);
// remaining stale docs carry over to the next run.
export function consolidateRefreshMaxPerRun() {
  return envInt("MEMORY_CONSOLIDATE_REFRESH_MAX_PER_RUN", 25);
}

// An already-disabled doc untouched for this many days is a compress-archived
// candidate (its body is truncated to free stored bytes).
export function consolidateArchiveAgeDays() {
  return envInt("MEMORY_CONSOLIDATE_ARCHIVE_AGE_DAYS", 180);
}

// Max body length for a compressed archived doc.
export function consolidateArchiveBodyMax() {
  return envInt("MEMORY_CONSOLIDATE_ARCHIVE_BODY_MAX", 1200);
}

// Max body length for a consolidated/refined (merge/rewrite) atom. Defaults to
// the shared atom cap so merges stay the same size class as normal atoms.
export function consolidateAtomBodyMaxChars() {
  return envInt("MEMORY_CONSOLIDATE_ATOM_BODY_MAX_CHARS", atomBodyMaxChars());
}

// Master switch for the two LLM passes (merge + refresh). Off => deterministic
// dedup/archive only (exact + lesson-key); fuzzy-similarity pairs are flag-only.
export function consolidateLlmEnabled() {
  return envBool("MEMORY_CONSOLIDATE_LLM", true);
}

// Schema-validation retry budget for an LLM pass call.
export function consolidateLlmMaxRetries() {
  return envInt("MEMORY_CONSOLIDATE_LLM_MAX_RETRIES", 2);
}

// CSV allow-list of pass names (or "all"). Resolution: explicit CLI/MCP arg >
// this env > "all". Returns the raw string for the orchestrator to parse.
export function consolidatePassesEnv() {
  return String(envValue("MEMORY_CONSOLIDATE_PASSES", "all") || "all");
}

// Recall-stamp debounce: recall_lessons / search_memory skip re-stamping
// last_recalled_at on a doc seen within this many hours (bounds write
// amplification on hot docs). Consumed by mcp-server/src/recall-stamp.js.
export function recallStampDebounceHours() {
  return envInt("MEMORY_RECALL_STAMP_DEBOUNCE_HOURS", 24);
}
