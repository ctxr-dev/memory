// Single source of truth for the PATH the maintenance pipeline needs.
//
// launchd and cron strip the login PATH down to /usr/bin:/bin:/usr/sbin:/sbin,
// which hides (a) the LLM provider CLIs (claude / codex / cursor-agent) the host
// compile/consolidate engines spawn, and (b) the `docker` binary the Dify bridge
// is reached through (`docker exec`). Either gap makes the hourly job ENOENT and
// silently skip work while reporting healthy.
//
// Two consumers, one contract:
//   - bootstrap.sh shells out to this file's CLI print mode and bakes the
//     result into the launchd plist EnvironmentVariables / Linux cron wrapper
//     (bash cannot import ESM);
//   - llm.mjs and dify-write.mjs import augmentSpawnEnv() so provider/docker
//     spawns heal at runtime even under a stale plist from an older install.
//
// Lives in mcp-server/src (not scripts/lib) so it is importable by BOTH runtimes
// (the host scripts import it via ../mcp-server/src/cron-path.mjs, like
// consolidate-core.js / consolidate-policy.js), matching the repo's dual-runtime
// convention.

import path from "node:path";
import { pathToFileURL } from "node:url";

// The PATH env var is "PATH" on POSIX but commonly "Path" on Windows / Git Bash.
// Find whichever casing an env object uses so we never drop the live PATH (and so
// augmentSpawnEnv writes back under the SAME key instead of creating a dual
// PATH/Path). Defaults to "PATH" when absent.
export function pathKeyOf(env) {
  if (env) {
    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === "path") return k;
    }
  }
  return "PATH";
}

// Well-known CLI install dirs across platforms and toolchain managers, plus the
// docker shim dirs this project's bridge needs (Rancher Desktop, Colima).
// Filesystem paths only. Pure string list: no fs probing, a nonexistent dir on
// PATH is harmless and probing would make the build nondeterministic.
export const CURATED_CLI_DIRS = Object.freeze([
  "~/.local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "~/.volta/bin",
  "~/.asdf/shims",
  "~/.bun/bin",
  "~/.deno/bin",
  "~/.cargo/bin",
  "~/n/bin",
  "~/.npm-global/bin",
  "/snap/bin",
  // docker shim dirs for the `docker exec` bridge transport (Rancher / Colima).
  "~/.rd/bin",
  "~/.colima/default/bin",
]);

// Hybrid PATH: live env PATH first (user wins), then the dir of the node binary
// that launched us (npm-shim CLIs need `node` resolvable), then the curated dirs.
// Deduped keeping first occurrence; `~` entries dropped when home is unknown (a
// literal `~` on PATH is never resolved by spawn). Uses `path.delimiter` (":" on
// POSIX, ";" on Windows) for both split and join so a native-Windows PATH (whose
// "C:\..." entries contain a colon) is not corrupted under Git Bash.
export function buildCronPath({ envPath = "", home = "", execPath = "" } = {}) {
  const segments = [];
  const seen = new Set();
  const push = (dir) => {
    if (!dir) return;
    if (seen.has(dir)) return;
    seen.add(dir);
    segments.push(dir);
  };

  for (const dir of String(envPath).split(path.delimiter)) push(dir.trim());
  if (execPath) push(path.dirname(execPath));
  for (const dir of CURATED_CLI_DIRS) {
    if (dir.startsWith("~/")) {
      if (home) push(path.join(home, dir.slice(2)));
    } else {
      push(dir);
    }
  }
  return segments.join(path.delimiter);
}

// Spawn-env wrapper for llm.mjs / dify-write.mjs: same merge, sourced from the
// child env (falling back to the process env) so an interactive session is a
// no-op dedup and a minimal cron env gains the curated dirs. Returns env
// unchanged when env is null/undefined (an API provider that never spawns a CLI).
export function augmentSpawnEnv(env) {
  if (!env) return env;
  const key = pathKeyOf(env); // preserve the env's own PATH casing (Windows "Path")
  return {
    ...env,
    [key]: buildCronPath({
      envPath: env[key] ?? process.env[pathKeyOf(process.env)] ?? "",
      home: env.HOME ?? process.env.HOME ?? "",
      execPath: process.execPath,
    }),
  };
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
  // No trailing newline: bootstrap captures this with "$(...)" verbatim.
  process.stdout.write(
    buildCronPath({
      envPath: process.env[pathKeyOf(process.env)] || "",
      home: process.env.HOME || "",
      execPath: process.execPath,
    }),
  );
}
