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

// Stable identity marker for entries we own in any hook event array.
// Everything generated from templates/{claude/settings,agents/hooks}.json
// has its `command` rooted at the project's `memory/scripts/hooks/`
// directory, so this substring appears in every entry we control and
// never in user-added entries (theirs point at THEIR scripts).
const HOOK_OWNERSHIP_MARKER = "/memory/scripts/hooks/";

export function isOurHookEntry(entry, marker = HOOK_OWNERSHIP_MARKER) {
  if (!entry || typeof entry !== "object") return false;
  const inner = Array.isArray(entry.hooks) ? entry.hooks : [];
  return inner.some(
    (h) => h && typeof h.command === "string" && h.command.includes(marker),
  );
}

// Merge the `hooks` block from `ours` into `target`, preserving every
// user-owned entry and replacing every ours-owned entry. Returns a fresh
// object; inputs are not mutated.
//
// Contract:
//   - target may be {} (no existing config) — output equals ours+target shape.
//   - For each event in ours.hooks: target.hooks[event] is filtered to drop
//     our previous entries (by `isOurHookEntry`), then ours' entries are
//     appended. Order of user entries is preserved.
//   - For events in target.hooks NOT mentioned in ours.hooks: passed through.
//   - Top-level keys other than `hooks` (e.g. `permissions`, `model`,
//     `enabledPlugins`) are passed through verbatim.
export function mergeHooksConfig(target, ours, marker = HOOK_OWNERSHIP_MARKER) {
  const out = { ...(target || {}) };
  const oursHooks = (ours && ours.hooks) || {};
  const targetHooks = (target && target.hooks) || {};
  const merged = { ...targetHooks };
  for (const event of Object.keys(oursHooks)) {
    const previous = Array.isArray(targetHooks[event]) ? targetHooks[event] : [];
    const userOwned = previous.filter((e) => !isOurHookEntry(e, marker));
    const oursForEvent = Array.isArray(oursHooks[event]) ? oursHooks[event] : [];
    merged[event] = [...userOwned, ...oursForEvent];
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
