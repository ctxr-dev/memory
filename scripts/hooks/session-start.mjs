import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MEMORY_DIR, COMPILE_STATE_PATH, envValue } from "../lib/env.mjs";
import { isReentrant, reentryEnv } from "../lib/reentry.mjs";
import { buildSessionStartContext } from "../lib/discipline.mjs";

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

  const child = spawn("node", [compileScript], {
    detached: true,
    stdio: "ignore",
    env: reentryEnv(RECURSION_GUARD),
    cwd: MEMORY_DIR,
  });
  child.unref();
  return true;
}

function maybeTriggerCompile() {
  // Value-agnostic guard: any memory-spawned process (compile OR a distiller
  // tagged memory-distill by llm.mjs) must not re-trigger compile.
  if (isReentrant()) return false;
  const state = readState();
  if (state.last_attempted_date === todayUtcDate()) return false;
  return spawnCompileDetached();
}

const memoryServerName = envValue("MCP_CONTAINER_NAME") || "<memory-server>";

const compileTriggered = (() => {
  try {
    return maybeTriggerCompile();
  } catch (err) {
    console.error(`session-start.mjs: compile trigger skipped: ${err instanceof Error ? err.message : err}`);
    return false;
  }
})();

// Routing discipline + Dify-slot detail live in the shared module so the MCP
// server (instructions on initialize) and this hook never drift.
const context = buildSessionStartContext({ serverName: memoryServerName, compileTriggered });

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
