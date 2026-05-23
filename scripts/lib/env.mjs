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
