// Verify scripts/lib/merge-config.mjs preserves user content while
// idempotently injecting/replacing our entries.
//
// The user's complaint that triggered this module: "I hope this is not
// just copied to target during installation with rewriting user
// existing settings". These tests lock that contract: a re-run of
// bootstrap NEVER touches a hook entry the user added themselves, and
// NEVER mutates a `permissions` / `model` / other top-level key.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isOurHookEntry,
  mergeHooksConfig,
  mergeMcpConfig,
  readJsonOrEmpty,
  writeJsonAtomic,
} from "../scripts/lib/merge-config.mjs";

// ---------- isOurHookEntry ----------

test("isOurHookEntry: true when any inner command path includes the marker", () => {
  const ours = {
    matcher: "",
    hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-start.sh', timeout: 15 }],
  };
  assert.equal(isOurHookEntry(ours), true);
});

test("isOurHookEntry: false for user-added entries (different path)", () => {
  const userOwned = {
    matcher: "Edit",
    hooks: [{ type: "command", command: "./scripts/lint.sh", timeout: 10 }],
  };
  assert.equal(isOurHookEntry(userOwned), false);
});

test("isOurHookEntry: handles malformed entries safely", () => {
  assert.equal(isOurHookEntry(null), false);
  assert.equal(isOurHookEntry(undefined), false);
  assert.equal(isOurHookEntry({}), false);
  assert.equal(isOurHookEntry({ hooks: null }), false);
  assert.equal(isOurHookEntry({ hooks: "wrong shape" }), false);
  assert.equal(isOurHookEntry({ hooks: [{ type: "command" }] }), false); // no command field
});

// ---------- mergeHooksConfig ----------

const OUR_TEMPLATE = {
  hooks: {
    SessionStart: [
      {
        matcher: "",
        hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-start.sh', timeout: 15 }],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-end.sh', timeout: 130 }],
      },
    ],
  },
};

test("mergeHooksConfig: empty target -> output equals our template (with hooks block intact)", () => {
  const merged = mergeHooksConfig({}, OUR_TEMPLATE);
  assert.deepEqual(merged.hooks.SessionStart, OUR_TEMPLATE.hooks.SessionStart);
  assert.deepEqual(merged.hooks.SessionEnd, OUR_TEMPLATE.hooks.SessionEnd);
});

test("mergeHooksConfig: preserves user-added hook entries on the SAME event", () => {
  const userExisting = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "./scripts/notify-startup.sh", timeout: 5 }],
        },
      ],
    },
  };
  const merged = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  // User entry survives, OUR entry appended.
  assert.equal(merged.hooks.SessionStart.length, 2);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, "./scripts/notify-startup.sh");
  assert.ok(merged.hooks.SessionStart[1].hooks[0].command.includes("/memory/scripts/hooks/session-start.sh"));
});

test("mergeHooksConfig: preserves user-only events not mentioned in our template", () => {
  const userExisting = {
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "./scripts/cleanup.sh", timeout: 5 }],
        },
      ],
    },
  };
  const merged = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  // Stop is user-only; must pass through verbatim.
  assert.deepEqual(merged.hooks.Stop, userExisting.hooks.Stop);
  // Our events are also present.
  assert.ok(Array.isArray(merged.hooks.SessionStart));
  assert.ok(Array.isArray(merged.hooks.SessionEnd));
});

test("mergeHooksConfig: re-run is idempotent (our entries replaced, not duplicated)", () => {
  const empty = {};
  const once = mergeHooksConfig(empty, OUR_TEMPLATE);
  const twice = mergeHooksConfig(once, OUR_TEMPLATE);
  const thrice = mergeHooksConfig(twice, OUR_TEMPLATE);
  assert.equal(once.hooks.SessionStart.length, 1);
  assert.equal(twice.hooks.SessionStart.length, 1);
  assert.equal(thrice.hooks.SessionStart.length, 1);
  assert.deepEqual(twice, once);
  assert.deepEqual(thrice, twice);
});

test("mergeHooksConfig: re-run with updated timeout REPLACES our prior entry", () => {
  const empty = {};
  const installed = mergeHooksConfig(empty, OUR_TEMPLATE);
  const updatedTemplate = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-start.sh', timeout: 30 }],
        },
      ],
    },
  };
  const reinstalled = mergeHooksConfig(installed, updatedTemplate);
  assert.equal(reinstalled.hooks.SessionStart.length, 1);
  assert.equal(reinstalled.hooks.SessionStart[0].hooks[0].timeout, 30);
});

test("mergeHooksConfig: preserves top-level non-hooks keys verbatim (permissions, model, etc.)", () => {
  const userExisting = {
    model: "claude-opus-4-7",
    permissions: { allow: ["Read", "Edit", "Bash(npm:*)"] },
    enabledPlugins: { "my-plugin@my-marketplace": true },
    hooks: {},
  };
  const merged = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  assert.equal(merged.model, "claude-opus-4-7");
  assert.deepEqual(merged.permissions, userExisting.permissions);
  assert.deepEqual(merged.enabledPlugins, userExisting.enabledPlugins);
  // Hooks section was added.
  assert.ok(merged.hooks.SessionStart);
});

test("mergeHooksConfig: mixed event with both user and our entries -> user kept, ours replaced", () => {
  // First install creates the joint state.
  const userExisting = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "./scripts/user-hook.sh", timeout: 5 }],
        },
      ],
    },
  };
  const installed = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  assert.equal(installed.hooks.SessionStart.length, 2);

  // Re-run with a new timeout: user entry should still be at index 0,
  // ours replaced at index 1 with the new timeout.
  const updatedTemplate = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-start.sh', timeout: 60 }],
        },
      ],
    },
  };
  const reinstalled = mergeHooksConfig(installed, updatedTemplate);
  assert.equal(reinstalled.hooks.SessionStart.length, 2);
  assert.equal(reinstalled.hooks.SessionStart[0].hooks[0].command, "./scripts/user-hook.sh");
  assert.equal(reinstalled.hooks.SessionStart[1].hooks[0].timeout, 60);
});

test("mergeHooksConfig: does not mutate inputs", () => {
  const target = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "./u.sh" }] }] } };
  const targetSnapshot = JSON.parse(JSON.stringify(target));
  const ours = JSON.parse(JSON.stringify(OUR_TEMPLATE));
  const oursSnapshot = JSON.parse(JSON.stringify(ours));
  mergeHooksConfig(target, ours);
  assert.deepEqual(target, targetSnapshot);
  assert.deepEqual(ours, oursSnapshot);
});

// ---------- mergeMcpConfig ----------

test("mergeMcpConfig: replaces our server entry, leaves other servers alone", () => {
  const userExisting = {
    mcpServers: {
      "playwright": { command: "npx", args: ["@playwright/mcp"] },
      "memory_mcp_old": { command: "docker", args: ["exec", "-i", "memory_mcp_old", "node", "src/index.js"] },
    },
  };
  const ours = {
    mcpServers: {
      "memory_mcp_old": { command: "docker", args: ["exec", "-i", "memory_mcp_old", "node", "src/index.js"], env: { NEW_FIELD: "x" } },
    },
  };
  const merged = mergeMcpConfig(userExisting, ours);
  // playwright untouched
  assert.deepEqual(merged.mcpServers.playwright, userExisting.mcpServers.playwright);
  // memory_mcp_old replaced
  assert.deepEqual(merged.mcpServers.memory_mcp_old.env, { NEW_FIELD: "x" });
});

test("mergeMcpConfig: empty target -> writes our entry", () => {
  const ours = {
    mcpServers: {
      "memory_mcp": { command: "docker", args: ["exec", "-i", "memory_mcp", "node", "src/index.js"] },
    },
  };
  const merged = mergeMcpConfig({}, ours);
  assert.deepEqual(merged.mcpServers.memory_mcp, ours.mcpServers.memory_mcp);
});

test("mergeMcpConfig: preserves top-level non-mcpServers keys verbatim", () => {
  const userExisting = {
    something: "user-set",
    mcpServers: {},
  };
  const merged = mergeMcpConfig(userExisting, { mcpServers: { mine: { command: "x" } } });
  assert.equal(merged.something, "user-set");
});

test("mergeMcpConfig: idempotent across repeated runs", () => {
  const ours = {
    mcpServers: {
      "memory_mcp": { command: "docker", args: ["exec", "-i", "memory_mcp", "node", "src/index.js"] },
    },
  };
  const a = mergeMcpConfig({}, ours);
  const b = mergeMcpConfig(a, ours);
  const c = mergeMcpConfig(b, ours);
  assert.deepEqual(b, a);
  assert.deepEqual(c, a);
});

// ---------- IO helpers ----------

test("readJsonOrEmpty: returns {} for nonexistent path", () => {
  assert.deepEqual(readJsonOrEmpty(path.join(os.tmpdir(), "merge-test-nonexistent-xyz.json")), {});
});

test("readJsonOrEmpty: returns {} for empty file", () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "merge-")), "empty.json");
  fs.writeFileSync(tmp, "");
  assert.deepEqual(readJsonOrEmpty(tmp), {});
});

test("readJsonOrEmpty: throws clearly on malformed JSON", () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "merge-")), "bad.json");
  fs.writeFileSync(tmp, "{ this is not json");
  assert.throws(() => readJsonOrEmpty(tmp), /Failed to parse JSON/);
});

test("writeJsonAtomic: creates parents + writes pretty JSON + trailing newline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  const tmp = path.join(dir, "nested", "deep", "out.json");
  writeJsonAtomic(tmp, { a: 1, b: [2, 3] });
  const text = fs.readFileSync(tmp, "utf8");
  assert.equal(text, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
});

// ---------- end-to-end via the CLI ----------

import { spawnSync } from "node:child_process";

const CLI = path.resolve("scripts/merge-config.mjs");

test("merge-config CLI: hooks strategy preserves user entries on real files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "settings.json");
  const source = path.join(dir, "ours.json");

  fs.writeFileSync(target, JSON.stringify({
    permissions: { allow: ["Read"] },
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: "./user.sh", timeout: 5 }] },
      ],
    },
  }));
  fs.writeFileSync(source, JSON.stringify(OUR_TEMPLATE));

  const r = spawnSync("node", [CLI, "--strategy=hooks", `--target=${target}`, `--source=${source}`], { encoding: "utf8" });
  assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);

  const out = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(out.permissions, { allow: ["Read"] }, "user permissions clobbered");
  assert.equal(out.hooks.SessionStart.length, 2);
  assert.equal(out.hooks.SessionStart[0].hooks[0].command, "./user.sh");
});

test("merge-config CLI: re-run is byte-stable (idempotent)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "settings.json");
  const source = path.join(dir, "ours.json");
  fs.writeFileSync(source, JSON.stringify(OUR_TEMPLATE));

  spawnSync("node", [CLI, "--strategy=hooks", `--target=${target}`, `--source=${source}`], { encoding: "utf8" });
  const first = fs.readFileSync(target, "utf8");
  spawnSync("node", [CLI, "--strategy=hooks", `--target=${target}`, `--source=${source}`], { encoding: "utf8" });
  const second = fs.readFileSync(target, "utf8");
  spawnSync("node", [CLI, "--strategy=hooks", `--target=${target}`, `--source=${source}`], { encoding: "utf8" });
  const third = fs.readFileSync(target, "utf8");
  assert.equal(second, first);
  assert.equal(third, first);
});

test("merge-config CLI: malformed target file aborts non-zero with clear message", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "bad.json");
  const source = path.join(dir, "ours.json");
  fs.writeFileSync(target, "{ this is not json");
  fs.writeFileSync(source, JSON.stringify(OUR_TEMPLATE));

  const r = spawnSync("node", [CLI, "--strategy=hooks", `--target=${target}`, `--source=${source}`], { encoding: "utf8" });
  assert.notEqual(r.status, 0, "should abort on bad JSON");
  assert.match(r.stderr, /Failed to parse JSON/);
});

test("merge-config CLI: --name=value form works (Bash quoting friendly)", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "settings.json");
  const source = path.join(dir, "ours.json");
  fs.writeFileSync(source, JSON.stringify(OUR_TEMPLATE));

  // --name=value form (no space)
  const r1 = spawnSync("node", [CLI, "--strategy=hooks", `--target=${target}`, `--source=${source}`], { encoding: "utf8" });
  assert.equal(r1.status, 0);

  // --name value form (space-separated)
  fs.unlinkSync(target);
  const r2 = spawnSync("node", [CLI, "--strategy", "hooks", "--target", target, "--source", source], { encoding: "utf8" });
  assert.equal(r2.status, 0);
});
