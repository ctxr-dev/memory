import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Merge newly-added keys from the .env template into an existing canonical
// settings/.env, so a `git pull` upgrade surfaces new knobs without the user
// hand-diffing the example. Append-only: existing lines and user values are
// never touched. A key counts as "present" in the target whether it is
// active (`KEY=`) or commented (`# KEY=`), and template keys are appended in
// their original form (commented stays commented) so optional knobs land
// commented-out, ready to enable.

const KEY_RE = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)=/;

// Extract the env-var name a line declares, active or commented, or null.
export function keyOf(line) {
  const m = KEY_RE.exec(line);
  return m ? m[1] : null;
}

// Set of every key declared (active or commented) anywhere in `text`.
export function declaredKeys(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const k = keyOf(line);
    if (k) keys.add(k);
  }
  return keys;
}

// Returns { merged, addedKeys }. `merged` is `targetText` with any template
// keys missing from the target appended under a dated header. Idempotent:
// a second call with the merged output adds nothing.
export function mergeEnvTemplate(templateText, targetText, { now = new Date() } = {}) {
  const present = declaredKeys(targetText);
  const seen = new Set();
  const addLines = [];
  const addedKeys = [];

  for (const line of templateText.split(/\r?\n/)) {
    const k = keyOf(line);
    if (!k) continue; // comments/blank/structural lines are not carried over
    if (present.has(k) || seen.has(k)) continue;
    seen.add(k);
    addLines.push(line);
    addedKeys.push(k);
  }

  if (addedKeys.length === 0) return { merged: targetText, addedKeys };

  const stamp = now.toISOString().slice(0, 10);
  // Match the target's existing newline style (CRLF on Windows-edited files,
  // else LF) for both the separator and the appended lines, so we never mix
  // line endings or miscount the blank-line separator.
  const eol = /\r\n/.test(targetText) ? "\r\n" : "\n";
  // Strictly append-only: preserve the target's existing bytes exactly, and
  // pick a separator so the block starts after AT LEAST one blank line (we
  // never trim the target, so a file already ending in several blank lines
  // keeps them — the append-only contract takes precedence over exact spacing).
  let sep;
  if (targetText === "" || targetText.endsWith(eol + eol)) sep = "";
  else if (targetText.endsWith(eol)) sep = eol;
  else sep = eol + eol;
  const block =
    sep +
    [`# ---- New keys merged from .env.example on ${stamp} ----`, ...addLines, ""].join(eol);
  return { merged: targetText + block, addedKeys };
}

// CLI: node merge-env.mjs <template> <target>
// Writes the merged target in place when keys were added; prints a one-line
// status to stdout (which keys were added, or that none were). Does not echo
// the merged file contents.
function main(argv) {
  const [templatePath, targetPath] = argv;
  if (!templatePath || !targetPath) {
    process.stderr.write("usage: merge-env.mjs <template> <target>\n");
    process.exit(2);
  }
  if (!fs.existsSync(templatePath)) {
    process.stderr.write(`merge-env: template not found: ${templatePath}\n`);
    process.exit(1);
  }
  if (!fs.existsSync(targetPath)) {
    // Nothing to merge into; the caller renders the template separately.
    process.stdout.write("merge-env: target absent; nothing to merge.\n");
    return;
  }
  const templateText = fs.readFileSync(templatePath, "utf8");
  const targetText = fs.readFileSync(targetPath, "utf8");
  const { merged, addedKeys } = mergeEnvTemplate(templateText, targetText);
  if (addedKeys.length === 0) {
    process.stdout.write("merge-env: no new keys; settings/.env already current.\n");
    return;
  }
  fs.writeFileSync(targetPath, merged);
  process.stdout.write(
    `merge-env: added ${addedKeys.length} new key(s) to ${targetPath}: ${addedKeys.join(", ")}\n`,
  );
}

// Run as CLI only when invoked directly (not when imported by tests).
// Compare resolved file URLs so a relative argv[1] or platform-specific path
// separators / URL escaping don't make the guard miss.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main(process.argv.slice(2));
}
