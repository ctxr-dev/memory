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

const memoryServerName = envValue("MCP_CONTAINER_NAME") || "<memory-server>";

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
  "Before starting any non-trivial task, call `recall_lessons` with the inferred project_module / language / task_type. Lessons live in the `self_improvement` Dify dataset; ignoring them defeats the boilerplate.",
  "When the user CORRECTS you (\"no\", \"stop doing X\", \"I told you before\", reverts your work), call `save_lesson` IMMEDIATELY (before replying) so the next turn can recall it. Required metadata: project_module, task_type, error_pattern.",
  "For task-specific memory, use `search_memory` with `filters` (atom_type, project_module, language, task_type, error_pattern, tags) and a `scoreThreshold`. Do NOT load the whole store.",
  "For durable artefacts (plans, investigations, decisions), use `save_to_dataset(dataset, name, text, metadata)` with upsert-by-name semantics: same name overwrites.",
  "Memory lives in Dify, organised by named dataset slots: daily, knowledge, plans, investigations, self_improvement (and any user-defined extras). PreCompact/PostCompact/SessionEnd hooks write `daily-<ts>.md` docs; once-per-day compile promotes daily atoms into the right slot (lessons -> self_improvement, everything else -> knowledge) and disables the source dailies.",
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
