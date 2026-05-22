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
    hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh', timeout: 15 }],
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

test("isOurHookEntry: REJECTS user paths even when they contain the substring 'memory/scripts/hooks/' (anchor regression)", () => {
  // Audit-flagged false-positive: a user with a hook at
  // ./tools/memory/scripts/hooks/custom.sh would be silently deleted
  // on bootstrap re-run by a plain substring marker. The signature
  // anchor includes the literal `"$CLAUDE_PROJECT_DIR"/` prefix, which
  // a user writing their own hook is overwhelmingly unlikely to
  // reproduce verbatim, so user-rooted paths under their own memory/
  // sub-tree are correctly recognised as theirs.
  for (const userPath of [
    "./tools/memory/scripts/hooks/custom.sh",
    "./mytools/memory/scripts/hooks/x.sh",
    "wrappermemory/scripts/hooks/x.sh",
    "/abs/user/memory/scripts/hooks/custom.sh",
    "memory/scripts/hooks/x.sh",  // bare relative
  ]) {
    const userEntry = {
      matcher: "",
      hooks: [{ type: "command", command: userPath, timeout: 5 }],
    };
    assert.equal(isOurHookEntry(userEntry), false, `should not match user path: ${userPath}`);
  }
});

test("isOurHookEntry: ACCEPTS our generated forms (full $CLAUDE_PROJECT_DIR signature)", () => {
  // The signature is the full byte sequence:
  //   "$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/
  // including the closing quote from the template render. This is what
  // every shipped template produces; nothing else should match.
  for (const oursPath of [
    '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh',
    '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/pre-compact.sh',
    '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/post-compact.sh',
    '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-end.sh',
  ]) {
    const oursEntry = {
      matcher: "",
      hooks: [{ type: "command", command: oursPath, timeout: 5 }],
    };
    assert.equal(isOurHookEntry(oursEntry), true, `should match ours: ${oursPath}`);
  }
});

test("isOurHookEntry: ACCEPTS the legacy memory/ signature (v0.4.0 upgrade-compat)", () => {
  // v0.4.0 moved the clone to <project>/.memory/src and the shipped templates
  // now render the .memory/src form (locked by the other positive tests + the
  // shipped-templates test). The LEGACY "$CLAUDE_PROJECT_DIR"/memory/... form
  // must ALSO stay recognised so a re-bootstrap after the documented migration
  // strips the stale pre-0.4.0 entries instead of duplicating them. Dropping
  // the legacy signature from HOOK_OWNERSHIP_SIGNATURES must fail this test.
  for (const legacyPath of [
    '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-start.sh',
    '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/pre-compact.sh',
    '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/post-compact.sh',
    '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-end.sh',
    '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/exit-plan-mode.sh',
  ]) {
    const legacyEntry = {
      matcher: "",
      hooks: [{ type: "command", command: legacyPath, timeout: 5 }],
    };
    assert.equal(isOurHookEntry(legacyEntry), true, `should still match legacy form: ${legacyPath}`);
  }
});

// ---------- mergeHooksConfig ----------

const OUR_TEMPLATE = {
  hooks: {
    SessionStart: [
      {
        matcher: "",
        hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh', timeout: 15 }],
      },
    ],
    SessionEnd: [
      {
        matcher: "",
        hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-end.sh', timeout: 130 }],
      },
    ],
    PostToolUse: [
      {
        matcher: "ExitPlanMode",
        hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/exit-plan-mode.sh', timeout: 30 }],
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
  assert.ok(merged.hooks.SessionStart[1].hooks[0].command.includes("/.memory/src/scripts/hooks/session-start.sh"));
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
          hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh', timeout: 30 }],
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
          hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh', timeout: 60 }],
        },
      ],
    },
  };
  const reinstalled = mergeHooksConfig(installed, updatedTemplate);
  assert.equal(reinstalled.hooks.SessionStart.length, 2);
  assert.equal(reinstalled.hooks.SessionStart[0].hooks[0].command, "./scripts/user-hook.sh");
  assert.equal(reinstalled.hooks.SessionStart[1].hooks[0].timeout, 60);
});

test("mergeHooksConfig: PostToolUse with same matcher 'ExitPlanMode' but user command is preserved alongside ours", () => {
  // Regression: the new exit-plan-mode hook is the first event we ship
  // with a non-empty matcher. mergeHooksConfig matches by inner-hook
  // command path (HOOK_OWNERSHIP_SIGNATURE), not by matcher value, so a
  // user PostToolUse entry with matcher: "ExitPlanMode" pointing at THEIR
  // OWN script must survive a re-run as a separate array element next to
  // ours. Loss of either entry is a critical regression.
  const userExisting = {
    hooks: {
      PostToolUse: [
        {
          matcher: "ExitPlanMode",
          hooks: [{ type: "command", command: "./tools/my-plan-archiver.sh", timeout: 10 }],
        },
      ],
    },
  };
  const merged = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  assert.equal(merged.hooks.PostToolUse.length, 2, "user entry + our entry");
  const userEntry = merged.hooks.PostToolUse.find((e) =>
    e.hooks.some((h) => h.command === "./tools/my-plan-archiver.sh"),
  );
  const ourEntry = merged.hooks.PostToolUse.find((e) =>
    e.hooks.some((h) => h.command.includes(".memory/src/scripts/hooks/exit-plan-mode.sh")),
  );
  assert.ok(userEntry, "user entry preserved");
  assert.ok(ourEntry, "our entry installed");
  assert.equal(userEntry.matcher, "ExitPlanMode");
  assert.equal(ourEntry.matcher, "ExitPlanMode");
  // Re-run is byte-stable (no duplication).
  const reRun = mergeHooksConfig(merged, OUR_TEMPLATE);
  assert.equal(reRun.hooks.PostToolUse.length, 2);
});

test("mergeHooksConfig: nested user path 'tools/memory/scripts/hooks/...' is preserved on re-run", () => {
  // Direct regression test for the anchored-marker fix. A user whose
  // build system happens to put scripts under a `memory/scripts/hooks/`
  // sub-tree (different parent dir) MUST keep their hook across re-runs.
  const userExisting = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "./tools/memory/scripts/hooks/custom.sh", timeout: 5 }],
        },
      ],
    },
  };
  const merged = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  // User entry survives, ours appended.
  assert.equal(merged.hooks.SessionStart.length, 2);
  assert.equal(merged.hooks.SessionStart[0].hooks[0].command, "./tools/memory/scripts/hooks/custom.sh");
  // Re-run idempotent.
  const reRun = mergeHooksConfig(merged, OUR_TEMPLATE);
  assert.equal(reRun.hooks.SessionStart.length, 2);
  assert.equal(reRun.hooks.SessionStart[0].hooks[0].command, "./tools/memory/scripts/hooks/custom.sh");
});

test("mergeHooksConfig: bundled inner-hook entry preserves user command, replaces only ours", () => {
  // Edge case: a single event entry has BOTH ours AND a user inner
  // hook (rare; happens when a user hand-edits to bundle). The
  // per-inner-hook filtering (vs the previous per-entry filter) must
  // preserve the user's inner hook while stripping ours, so on re-run
  // the user's hook is NOT lost.
  const userExisting = {
    hooks: {
      SessionEnd: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-end.sh', timeout: 130 },
            { type: "command", command: "./scripts/user-cleanup.sh", timeout: 10 },
          ],
        },
      ],
    },
  };
  const merged = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  // The original entry should be preserved with ONLY the user's inner
  // hook left, then ours appended as a separate entry.
  assert.equal(merged.hooks.SessionEnd.length, 2);
  assert.equal(merged.hooks.SessionEnd[0].hooks.length, 1);
  assert.equal(merged.hooks.SessionEnd[0].hooks[0].command, "./scripts/user-cleanup.sh");
  // Ours appended as a fresh entry.
  assert.ok(merged.hooks.SessionEnd[1].hooks[0].command.includes("/.memory/src/scripts/hooks/session-end.sh"));
});

test("mergeHooksConfig: entry that was 100% ours is dropped, not kept as empty stub", () => {
  // After installing once, a re-install must NOT leave an entry whose
  // `hooks` array has been emptied. The drop-when-empty rule keeps the
  // file clean and idempotent.
  const userExisting = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh', timeout: 15 }],
        },
      ],
    },
  };
  const merged = mergeHooksConfig(userExisting, OUR_TEMPLATE);
  // Should have exactly one entry (the freshly-injected ours), not two
  // (an empty stub from the user's old entry + ours).
  assert.equal(merged.hooks.SessionStart.length, 1);
  assert.equal(merged.hooks.SessionStart[0].hooks.length, 1);
});

test("mergeHooksConfig: v0.4.0 upgrade strips LEGACY memory/ entries and installs .memory/src ones (no duplication)", () => {
  // The documented migration is `mv ./memory ./.memory/src` then re-run
  // bootstrap. At that point the user's settings.json still carries the
  // pre-0.4.0 hook entries pointing at "$CLAUDE_PROJECT_DIR"/memory/... .
  // The dual ownership signature must recognise those legacy entries as
  // OURS so they are stripped, not preserved as user entries next to the
  // freshly rendered .memory/src ones.
  const legacyInstalled = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/memory/scripts/hooks/session-start.sh', timeout: 15 }],
        },
      ],
    },
  };
  const newTemplate = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh', timeout: 15 }],
        },
      ],
    },
  };
  const merged = mergeHooksConfig(legacyInstalled, newTemplate);
  // Exactly one entry: the legacy one is stripped, the new one installed.
  assert.equal(merged.hooks.SessionStart.length, 1);
  assert.equal(
    merged.hooks.SessionStart[0].hooks[0].command,
    '"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/session-start.sh',
  );
  // Re-run is idempotent (no duplicate, byte-stable).
  const reRun = mergeHooksConfig(merged, newTemplate);
  assert.deepEqual(reRun, merged);
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

// ---------- shipped-template marker lock ----------
//
// A future contributor editing templates/{claude/settings,agents/hooks}.json
// to use a different env-var spelling (e.g., `${CLAUDE_PROJECT_DIR}` or
// `$HOME/memory/scripts/hooks/`) would silently break the
// HOOK_OWNERSHIP_SIGNATURE marker — bootstrap re-runs would then DUPLICATE
// our hook entries on every run instead of replacing them, with no test
// failure to catch the drift. This test loads the actual shipped templates
// and asserts every event entry is recognised by isOurHookEntry. If a
// template edit ever breaks the marker, this test fails loudly.

test("shipped templates: every hook entry in templates/{claude/settings,agents/hooks}.json matches isOurHookEntry", () => {
  const templates = [
    path.resolve("templates/claude/settings.json"),
    path.resolve("templates/agents/hooks.json"),
  ];
  let totalChecked = 0;
  for (const t of templates) {
    assert.ok(fs.existsSync(t), `template missing: ${t}`);
    const j = JSON.parse(fs.readFileSync(t, "utf8"));
    assert.ok(j.hooks && typeof j.hooks === "object", `${t}: no hooks block`);
    for (const event of Object.keys(j.hooks)) {
      assert.ok(Array.isArray(j.hooks[event]), `${t}: hooks.${event} is not an array`);
      for (const entry of j.hooks[event]) {
        assert.equal(
          isOurHookEntry(entry),
          true,
          `${t}: hooks.${event} entry is NOT recognised by isOurHookEntry — ` +
          `the marker (HOOK_OWNERSHIP_SIGNATURE in scripts/lib/merge-config.mjs) ` +
          `must appear in every command we ship, otherwise bootstrap re-runs ` +
          `will duplicate hook entries instead of replacing them. Entry: ${JSON.stringify(entry)}`,
        );
        totalChecked += 1;
      }
    }
  }
  // Sanity: both templates ship 5 events × 1 entry each = 10 commands
  // (SessionStart, PreCompact, PostCompact, SessionEnd, PostToolUse).
  // If this drops, someone removed events from templates without updating
  // the test; if it grows, someone added events and should also update
  // bootstrap.sh's merge_strategy_for if a new file appears.
  assert.ok(totalChecked >= 10, `expected at least 10 entries across templates; got ${totalChecked}`);
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
