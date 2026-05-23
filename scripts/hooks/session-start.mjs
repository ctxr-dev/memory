import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MEMORY_DIR, COMPILE_STATE_PATH, envValue } from "../lib/env.mjs";
import { isReentrant, reentryEnv } from "../lib/reentry.mjs";

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

const context = [
  `Project memory is available through the \`${memoryServerName}\` MCP server.`,
  // The default-routing rule first — without this, agents fall back
  // to whatever memory system they were trained on (Claude Code's
  // local file memory, Cursor's, etc.) when the user says "save /
  // memorize / remember", silently bypassing the RAG store this
  // project ships with. Listing the right tools is not enough; the
  // default has to be made explicit. But it must be CONDITIONAL on
  // RAG being healthy — an absolute "never local" rule would lose
  // the user's intent entirely when the cloud-side stack is down.
  "MEMORY ROUTING (default): when the user says \"save to memory\", \"memorize this\", \"remember that\", \"save it for later\", or any equivalent — the project's RAG memory MCP server is the DEFAULT destination AS LONG AS IT IS HEALTHY. Healthy means: the bridge is reachable AND a destination dataset slot is bound (a sane probe is to attempt `save_to_dataset` / `save_lesson` and treat success as healthy). When healthy, USE the MCP tools below; do NOT write to your client's local file-based memory (Claude Code's ~/.claude/projects/.../memory/*.md, Cursor's project memory, etc.) for the same content — the local store is per-client and per-session and is invisible to every other agent on this project. When the RAG MCP server is not registered, OR is registered but unhealthy (bridge down, datasets unbound, calls erroring), FALL BACK to your client's local memory and tell the user one short line that you did so. Don't refuse to save just because the cloud side is dead. Routing when healthy:",
  "  - Behavioural lesson about the AI itself (correction, repeated mistake, rule for next time) -> `save_lesson` (writes to the `self_improvement` slot, surfaced by `recall_lessons`).",
  "  - Project fact / decision / lore (how the workspace works, who-does-what, conventions, integration quirks) -> `save_to_dataset(dataset=\"knowledge\", name=\"<artefact>.md\", text, metadata)`.",
  "  - Plan or investigation as a durable artefact (upsert-by-name; same name overwrites) -> `save_to_dataset(dataset=\"plans\" or \"investigations\", name=\"<short-slug>.md\", text, metadata)`. NOTE: plans approved via ExitPlanMode are AUTO-CAPTURED to the `plans` slot by the boilerplate's PostToolUse hook (`scripts/hooks/exit-plan-mode.sh`), so do NOT also call `save_to_dataset` for an approved plan. Manual `save_to_dataset` is for mid-iteration plans, investigations, and stand-alone artefacts.",
  "Before starting any non-trivial task, call `recall_lessons` with the inferred project_module / language / task_type. Lessons live in the `self_improvement` Dify dataset; ignoring them defeats the boilerplate.",
  "When the user CORRECTS you (\"no\", \"stop doing X\", \"I told you before\", reverts your work), call `save_lesson` IMMEDIATELY (before replying) so the next turn can recall it. Required metadata: project_module, task_type, error_pattern.",
  "For task-specific memory, use `search_memory` with `filters` (atom_type, project_module, language, task_type, error_pattern, tags) and a `scoreThreshold`. Do NOT load the whole store.",
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
