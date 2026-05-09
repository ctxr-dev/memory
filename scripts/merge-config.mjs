#!/usr/bin/env node
// CLI wrapper for scripts/lib/merge-config.mjs.
//
// Invoked from bootstrap.sh to merge our shipped JSON template into the
// user's existing config without losing any of their content. Exits
// non-zero on parse/IO error so the caller (bootstrap.sh) can fail fast
// with a clear message instead of silently writing a half-merged file.
//
// Usage:
//   node scripts/merge-config.mjs --strategy=hooks --target=<existing.json> --source=<rendered-template.json>
//   node scripts/merge-config.mjs --strategy=mcp   --target=<existing.json> --source=<rendered-template.json>
//
// Strategies:
//   hooks  Deep-merge the `hooks` block. Owned identity: command path
//          contains `/memory/scripts/hooks/`. User-added hooks survive.
//   mcp    Replace ONLY our `mcpServers.<bridge-name>` entry. Other
//          servers in the user's mcp.json survive.
//
// Side effects: writes/overwrites <target> with the merged result, using
// an atomic tmp+rename. Creates parent directories as needed.

import {
  mergeHooksConfig,
  mergeMcpConfig,
  readJsonOrEmpty,
  writeJsonAtomic,
} from "./lib/merge-config.mjs";

function flag(name) {
  const args = process.argv.slice(2);
  // Support both `--name value` and `--name=value` forms so callers
  // (Bash, Powershell users in WSL, etc.) can use whichever is more
  // natural to their shell quoting.
  const equalsForm = args.find((a) => a.startsWith(`--${name}=`));
  if (equalsForm) return equalsForm.slice(`--${name}=`.length);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return null;
}

function die(msg, code = 1) {
  process.stderr.write(`merge-config: ${msg}\n`);
  process.exit(code);
}

const strategy = flag("strategy");
const targetPath = flag("target");
const sourcePath = flag("source");

if (!strategy || !targetPath || !sourcePath) {
  die(
    "Usage: merge-config.mjs --strategy=<hooks|mcp> --target=<path> --source=<path>",
  );
}

let target;
try {
  target = readJsonOrEmpty(targetPath);
} catch (err) {
  die(err.message);
}

let source;
try {
  source = readJsonOrEmpty(sourcePath);
} catch (err) {
  die(err.message);
}

let merged;
if (strategy === "hooks") {
  merged = mergeHooksConfig(target, source);
} else if (strategy === "mcp") {
  merged = mergeMcpConfig(target, source);
} else {
  die(`Unknown strategy '${strategy}'. Use 'hooks' or 'mcp'.`);
}

try {
  writeJsonAtomic(targetPath, merged);
} catch (err) {
  die(`Failed to write ${targetPath}: ${err.message}`);
}

process.stdout.write(`merged ${strategy}: ${targetPath}\n`);
