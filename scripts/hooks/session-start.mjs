import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MEMORY_DIR, DAILY_DIR, STATE_PATH, envValue } from "../lib/env.mjs";

const RECURSION_GUARD = "memory_compile";

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { last_compiled_date: "", compiled_files: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { last_compiled_date: "", compiled_files: {} };
  }
}

function hasUnprocessedDailyLogs(state) {
  if (!fs.existsSync(DAILY_DIR)) return false;
  const today = todayUtcDate();
  return fs
    .readdirSync(DAILY_DIR)
    .some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) < today && !state.compiled_files[f]);
}

function spawnCompileDetached() {
  const compileScript = path.join(MEMORY_DIR, "scripts", "compile.mjs");
  if (!fs.existsSync(compileScript)) return false;

  const env = { ...process.env, CLAUDE_INVOKED_BY: RECURSION_GUARD };
  const child = spawn("node", [compileScript], {
    detached: true,
    stdio: "ignore",
    env,
    cwd: MEMORY_DIR,
  });
  child.unref();
  return true;
}

function maybeTriggerCompile() {
  if (process.env.CLAUDE_INVOKED_BY === RECURSION_GUARD) return false;
  const state = readState();
  const today = todayUtcDate();
  if (state.last_compiled_date === today) return false;
  if (!hasUnprocessedDailyLogs(state)) return false;
  return spawnCompileDetached();
}

const memoryServerName = envValue("MCP_CONTAINER_NAME") || envValue("MEMORY_SERVER_NAME") || "<memory-server>";

const compileTriggered = (() => {
  try {
    return maybeTriggerCompile();
  } catch (err) {
    console.error(`session-start.mjs: compile trigger skipped: ${err instanceof Error ? err.message : err}`);
    return false;
  }
})();

const context = [
  `Project memory is available through the \`${memoryServerName}\` MCP server.`,
  "Use `search_memory` before relying on project-history assumptions, architecture decisions, integration details, or previous session conclusions.",
  "Use `write_memory` to record explicit durable decisions; pass `supersedes` to retire an existing entry.",
  "Hooks distil PreCompact/PostCompact/SessionEnd into local daily logs (./memory/daily/). Compile runs lazily on the first SessionStart of a new UTC day to dedup-merge atoms into Dify.",
  compileTriggered
    ? "Compile was triggered in the background for unprocessed daily logs."
    : "No unprocessed daily logs to compile this session start.",
].join("\n");

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
