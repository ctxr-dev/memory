// Deterministic structural merge of our shipped JSON templates into a
// user's existing config files, preserving everything we don't own.
//
// Why pure Node, no jq:
//   - jq is not POSIX, not preinstalled on every Linux distro, missing
//     from Git Bash on Windows by default.
//   - Node is already a hard dependency of this project (compile.mjs,
//     flush.mjs, mcp-server). Reusing it costs zero extra prereqs.
//   - The merges are structurally trivial; an LLM at install time would
//     be over-engineering and would put a non-deterministic, network-
//     bound dependency in the security-sensitive hook install path.
//
// Two merge strategies:
//
// 1. mergeHooksConfig (.claude/settings.json, .agents/hooks.json):
//    For each Claude Code hook event (SessionStart, PreCompact, ...) the
//    config holds an array of {matcher, hooks: [{type, command, timeout}]}
//    entries. We "own" entries whose inner command path passes through
//    `/memory/scripts/hooks/`. On merge we strip our previous entries
//    from each event's array and append the freshly-rendered ones; user-
//    added entries (their own hooks pointing at their own scripts) are
//    untouched. Re-runs are idempotent because the strip+append is
//    deterministic and we own a stable identity marker (the path
//    substring).
//
// 2. mergeMcpConfig (.agents/mcp.json):
//    Holds a `mcpServers` object keyed by server name. We own a single
//    key (the bridge container name). Other servers the user has
//    configured pass through verbatim. Re-runs replace ONLY our key.
//
// Anything not covered by these strategies (skill markdown files, the
// per-server `.mcp.json` snippets we generate from scratch) stays on
// the per-file conflict-refuse path in bootstrap.sh because the content
// is atomic and a structural merge would be meaningless.

import fs from "node:fs";
import path from "node:path";

// Stable identity marker for inner hook commands we own. Every command
// we generate from templates/{claude/settings,agents/hooks}.json has
// the literal signature
//   "$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/
// after JSON-decoding (the templates ship the escaped form
// `\"$CLAUDE_PROJECT_DIR\"/memory/scripts/hooks/`). This signature is
// distinctive: it bundles a Claude-Code-specific env var, the closing
// quote pattern from our template renderer, AND the install path. A
// user writing their own hook is overwhelmingly unlikely to reproduce
// this exact byte sequence, so a substring match is sound.
//
// Rejected alternative: anchoring on `memory/scripts/hooks/` with a
// leading `/` or `"` boundary still false-positives on user paths like
// `./tools/memory/scripts/hooks/custom.sh` (the boundary char is `/`,
// satisfied by `s/m`). The full env-var signature avoids this trap.
//
// To change the install root from `memory/`, update both this constant
// AND the templates. Tests in test/merge-config.test.mjs lock the
// contract (positive: our commands match; negative: nested user paths
// containing `memory/scripts/hooks/` substrings do not).
const HOOK_OWNERSHIP_SIGNATURE = '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/';

// Predicate: is this individual inner hook one of OURS? Operates on a
// single `{type, command, timeout}` entry, NOT on an event array entry.
// Splitting at this level lets us preserve user commands that happen to
// share an event array entry with one of ours (rare but possible if the
// user hand-edits to bundle).
function isOurInnerHook(h) {
  return !!(h && typeof h.command === "string" && h.command.includes(HOOK_OWNERSHIP_SIGNATURE));
}

// Predicate: does this event-array entry contain ANY hook we own?
// Exposed for tests/diagnostics. Not used by mergeHooksConfig anymore
// (we now filter at the inner-hook level for sharper preservation).
export function isOurHookEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
  return inner.some(isOurInnerHook);
}

// Strip our inner hooks from a single event-array entry. Returns null
// if every inner hook was ours (the entry is now empty, drop it);
// otherwise returns a NEW entry with the user's inner hooks preserved.
function filterOurInnerHooksFromEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
  const userInner = inner.filter((h) => !isOurInnerHook(h));
  if (userInner.length === inner.length) return entry;  // none of ours — pass through unchanged
  if (userInner.length === 0) return null;              // entry was entirely ours — drop
  return { ...entry, hooks: userInner };                // mixed — keep user's, drop ours
}

// Merge the `hooks` block from `ours` into `target`, preserving every
// user-owned hook and replacing every ours-owned hook. Returns a fresh
// object; inputs are not mutated.
//
// Contract:
//   - target may be {} (no existing config) — output equals ours+target shape.
//   - For each event in ours.hooks:
//       1. For each entry in target.hooks[event]: strip our inner hooks.
//          If the entry becomes empty, drop it. If it had any user hooks,
//          keep it with only those.
//       2. Append ours' entries for the event.
//     Order of preserved user entries is stable.
//   - For events in target.hooks NOT mentioned in ours.hooks: passed through verbatim.
//   - Top-level keys other than `hooks` (e.g. `permissions`, `model`,
//     `enabledPlugins`) are passed through verbatim.
//
// Why per-INNER-HOOK filtering rather than per-ENTRY: a user who hand-
// edits the config to bundle their own command into the same event-array
// entry as ours (rare but possible) MUST NOT lose their command on a
// bootstrap re-run. The previous per-entry policy would have deleted
// the whole entry; this version preserves their inner hook and replaces
// only ours.
export function mergeHooksConfig(target, ours) {
  const out = { ...(target || {}) };
  const oursHooks = (ours && ours.hooks) || {};
  const targetHooks = (target && target.hooks) || {};
  const merged = { ...targetHooks };
  for (const event of Object.keys(oursHooks)) {
    const previous = Array.isArray(targetHooks[event]) ? targetHooks[event] : [];
    const preservedUserEntries = previous
      .map(filterOurInnerHooksFromEntry)
      .filter((e) => e !== null);
    const oursForEvent = Array.isArray(oursHooks[event]) ? oursHooks[event] : [];
    merged[event] = [...preservedUserEntries, ...oursForEvent];
  }
  out.hooks = merged;
  return out;
}

// Merge the `mcpServers` block from `ours` into `target`. We own
// whichever keys appear in ours.mcpServers (typically one — the bridge
// container name); other keys pass through.
export function mergeMcpConfig(target, ours) {
  const out = { ...(target || {}) };
  const oursServers = (ours && ours.mcpServers) || {};
  const targetServers = (target && target.mcpServers) || {};
  const merged = { ...targetServers };
  for (const key of Object.keys(oursServers)) {
    merged[key] = oursServers[key];
  }
  out.mcpServers = merged;
  return out;
}

// Convenience: read a JSON file or return {} if it doesn't exist.
// Throws on parse error so a malformed user file isn't silently clobbered.
export function readJsonOrEmpty(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err.message}`);
  }
}

// Convenience: write JSON atomically (tmp + rename) so a concurrent
// reader can't see a half-written file. Pretty-prints with 2-space
// indent and a trailing newline for clean diffs.
export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}
