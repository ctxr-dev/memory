import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MEMORY_DIR, COMPILE_STATE_PATH, envValue } from "../lib/env.mjs";

const RECURSION_GUARD = "memory_compile";

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function readState() {
  if (!fs.existsSync(COMPILE_STATE_PATH)) return { last_attempted_date: "" };
  try {
    return JSON.parse(fs.readFileSync(COMPILE_STATE_PATH, "utf8"));
  } catch {
    return { last_attempted_date: "" };
  }
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
  if (state.last_attempted_date === todayUtcDate()) return false;
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
  "Memory lives in Dify as two document families: `daily-<ts>.md` (raw flush output) and `knowledge-<slug>-<ts>.md` (deduped, merged). PreCompact/PostCompact/SessionEnd hooks write daily docs; once-per-day compile promotes daily atoms into knowledge docs and disables the source dailies.",
  compileTriggered
    ? "Compile was triggered in the background to promote any unprocessed daily docs."
    : "Compile was already attempted today; skipped this session start.",
].join("\n");

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
