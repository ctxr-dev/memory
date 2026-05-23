// Lock the distiller-isolation contract in scripts/lib/llm.mjs.
//
// The forked distiller must run with NO project MCP servers (it needs no
// tools, and loading the project .mcp.json would let an unrelated MCP server
// with a bad tool schema break distillation). buildClaudeArgs encodes that
// via --strict-mcp-config + an empty --mcp-config. Separately, both CLI
// distillers (claude, codex) must spawn with the re-entry guard env.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildClaudeArgs } from "../scripts/lib/llm.mjs";

test("buildClaudeArgs: runs the distiller with no project MCP (strict + empty config)", () => {
  const args = buildClaudeArgs({ systemPrompt: "SYS", userPrompt: "USR" });
  assert.ok(args.includes("--strict-mcp-config"), "must pass --strict-mcp-config");
  const i = args.indexOf("--mcp-config");
  assert.ok(i !== -1, "must pass --mcp-config");
  assert.equal(args[i + 1], '{"mcpServers":{}}', "must pass an empty mcp config");
});

test("buildClaudeArgs: runs the distiller with no built-in tools (empty allow-list)", () => {
  // Without this the model tries to Write the atoms to a file and burns its
  // single turn on a denied tool call instead of returning JSON text.
  const args = buildClaudeArgs({ systemPrompt: "SYS", userPrompt: "USR" });
  const i = args.indexOf("--allowedTools");
  assert.ok(i !== -1, "must pass --allowedTools");
  assert.equal(args[i + 1], "", "allow-list must be empty (no tools)");
});

test("buildClaudeArgs: print mode, json output, single turn", () => {
  const args = buildClaudeArgs({ systemPrompt: "", userPrompt: "U" });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("--output-format=json"));
  assert.ok(args.includes("--max-turns=1"));
});

test("buildClaudeArgs: system prompt passed when present, user prompt is last", () => {
  const withSys = buildClaudeArgs({ systemPrompt: "SYS", userPrompt: "U" });
  const si = withSys.indexOf("--system-prompt");
  assert.ok(si !== -1, "system prompt flag present");
  assert.equal(withSys[si + 1], "SYS");
  assert.equal(withSys[withSys.length - 1], "U", "user prompt is the final positional arg");
});

test("buildClaudeArgs: system prompt omitted when empty", () => {
  const noSys = buildClaudeArgs({ systemPrompt: "", userPrompt: "U" });
  assert.equal(noSys.includes("--system-prompt"), false);
  assert.equal(noSys[noSys.length - 1], "U");
});

// Source lock: a forked distiller must carry the re-entry guard env or it
// would re-fire the memory hooks. Both CLI providers (claude + codex) spawn
// via spawnCapture with `env: reentryEnv(...)`.
test("llm.mjs: both CLI distillers spawn with env: reentryEnv(...)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(here, "..", "scripts", "lib", "llm.mjs"), "utf8");
  const guardSpawns = src.match(/env:\s*reentryEnv\(/g) || [];
  assert.ok(
    guardSpawns.length >= 2,
    `expected the claude and codex spawns to set env: reentryEnv(...), found ${guardSpawns.length}`,
  );
});
