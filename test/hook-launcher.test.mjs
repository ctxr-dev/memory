// Tests for the W18z hook-launcher contract:
//
//   bash -c ': ctxr-memory-hook-v1; DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"; ...'
//
// Lives in templates/{claude/settings,agents/hooks}.json and ships into
// every consumer project's .claude/settings.json (and .agents/hooks.json
// for non-Claude clients). The contract:
//
//   1. Prefer $CLAUDE_PROJECT_DIR when set.
//   2. Fall back to $(pwd) when not set.
//   3. If the resolved hook script is missing, log to
//      .memory/src/.hook-launcher.log and exit 0 (never block the agent).
//   4. When the script IS present, exec it (so stdin / stdout / stderr
//      flow through transparently).
//   5. The sentinel `: ctxr-memory-hook-v1` is a no-op runtime cost but
//      is the marker scripts/lib/merge-config.mjs uses to identify
//      "our" hooks for idempotent re-merge.
//
// Why these tests matter: this exact bug — $CLAUDE_PROJECT_DIR being
// unset in the hook subprocess, the command path resolving to
// "/.memory/..." (root-of-filesystem), the script failing to run, and
// Claude Code silently swallowing the error — kept approved plans out
// of Dify for the entire 0.x.x line. The launcher above is the fix and
// these tests pin the contract so it cannot regress.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Pull the exact command strings the templates ship. If the templates
// change, these tests run against the new shape automatically; if the
// shape diverges from the contract we assert below, that's a real bug
// the test surfaces.
function loadLauncherCommands(templatePath) {
  const j = JSON.parse(fs.readFileSync(templatePath, "utf8"));
  const out = {};
  for (const event of Object.keys(j.hooks || {})) {
    for (const entry of j.hooks[event]) {
      for (const inner of entry.hooks || []) {
        // Use the hook script basename as the key (e.g. "session-start.sh").
        const m = inner.command.match(/\/scripts\/hooks\/([\w-]+\.sh)/);
        if (m) out[m[1]] = inner.command;
      }
    }
  }
  return out;
}

const CLAUDE_TEMPLATE = path.resolve("templates/claude/settings.json");
const AGENTS_TEMPLATE = path.resolve("templates/agents/hooks.json");

test("launcher template (claude): every command starts with bash -c ': ctxr-memory-hook-v1;", () => {
  const cmds = loadLauncherCommands(CLAUDE_TEMPLATE);
  assert.ok(Object.keys(cmds).length >= 5, "expected >=5 hook commands");
  for (const [name, cmd] of Object.entries(cmds)) {
    assert.match(
      cmd,
      /^bash -c ': ctxr-memory-hook-v1;/,
      `${name}: must use the bash -c sentinel launcher`,
    );
  }
});

test("launcher template (agents): every command starts with bash -c ': ctxr-memory-hook-v1;", () => {
  const cmds = loadLauncherCommands(AGENTS_TEMPLATE);
  for (const [name, cmd] of Object.entries(cmds)) {
    assert.match(
      cmd,
      /^bash -c ': ctxr-memory-hook-v1;/,
      `${name}: must use the bash -c sentinel launcher`,
    );
  }
});

test("launcher template (claude): every command resolves $CLAUDE_PROJECT_DIR with a $(pwd) fallback", () => {
  const cmds = loadLauncherCommands(CLAUDE_TEMPLATE);
  for (const [name, cmd] of Object.entries(cmds)) {
    assert.match(
      cmd,
      /DIR="\$\{CLAUDE_PROJECT_DIR:-\$\(pwd\)\}"/,
      `${name}: must resolve CLAUDE_PROJECT_DIR with pwd fallback`,
    );
  }
});

test("launcher template (claude): every command logs missing-script and exits 0 instead of blocking", () => {
  const cmds = loadLauncherCommands(CLAUDE_TEMPLATE);
  for (const [name, cmd] of Object.entries(cmds)) {
    assert.match(cmd, /hook-launcher: missing/, `${name}: must log missing-script`);
    assert.match(cmd, /\.hook-launcher\.log/, `${name}: must log to .hook-launcher.log`);
    assert.match(cmd, /exit 0/, `${name}: must exit 0 on miss`);
  }
});

// ---------------------------------------------------------------------------
// Behavioural tests: actually run the launcher command and assert outcomes.
// ---------------------------------------------------------------------------

function runLauncher(command, cwd, env = {}) {
  // Wrap the JSON-decoded command in `bash -c <inner>` after stripping
  // the outer `bash -c ` — but actually the easier path: write the
  // inner script to a temp file and run it. Cleanest: invoke /bin/bash
  // with the full string as -c arg by extracting the inner quoted
  // payload from the command.
  //
  // Templates ship: bash -c '<payload>'
  // We need to extract <payload>. The single quotes don't appear inside
  // the payload (we use double quotes there), so a simple regex works.
  const m = command.match(/^bash -c '(.*)'$/s);
  assert.ok(m, `command does not match 'bash -c \"...\"' shape: ${command.slice(0, 80)}...`);
  const inner = m[1];
  return spawnSync("/bin/bash", ["-c", inner], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 5000,
  });
}

function pickCommand(scriptName) {
  return loadLauncherCommands(CLAUDE_TEMPLATE)[scriptName];
}

test("launcher (behavioural): runs the hook when CLAUDE_PROJECT_DIR is set and the script exists", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-launcher-set-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const hookDir = path.join(dir, ".memory/src/scripts/hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  // Plant a fake session-start.sh that writes to a sentinel file.
  const sentinel = path.join(dir, "hook-ran.flag");
  const fakeHook = path.join(hookDir, "session-start.sh");
  fs.writeFileSync(fakeHook, `#!/usr/bin/env bash\necho "fake hook ran" > "${sentinel}"\n`);
  fs.chmodSync(fakeHook, 0o755);

  const cmd = pickCommand("session-start.sh");
  // Set CLAUDE_PROJECT_DIR to our tmpdir; run from elsewhere to prove
  // it's the env var (not pwd) that resolves.
  const result = runLauncher(cmd, os.tmpdir(), { CLAUDE_PROJECT_DIR: dir });

  assert.equal(result.status, 0, `launcher should exit 0; stderr: ${result.stderr}`);
  assert.equal(fs.existsSync(sentinel), true, "fake hook should have executed");
  assert.equal(
    fs.readFileSync(sentinel, "utf8").trim(),
    "fake hook ran",
    "sentinel content from fake hook should be present",
  );
});

test("launcher (behavioural): falls back to $(pwd) when CLAUDE_PROJECT_DIR is unset", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-launcher-pwd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const hookDir = path.join(dir, ".memory/src/scripts/hooks");
  fs.mkdirSync(hookDir, { recursive: true });
  const sentinel = path.join(dir, "hook-ran.flag");
  const fakeHook = path.join(hookDir, "session-start.sh");
  fs.writeFileSync(fakeHook, `#!/usr/bin/env bash\necho "pwd fallback" > "${sentinel}"\n`);
  fs.chmodSync(fakeHook, 0o755);

  const cmd = pickCommand("session-start.sh");
  // Explicitly strip CLAUDE_PROJECT_DIR; cwd points at the project root.
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const result = spawnSync(
    "/bin/bash",
    ["-c", cmd.match(/^bash -c '(.*)'$/s)[1]],
    { cwd: dir, env, encoding: "utf8", timeout: 5000 },
  );

  assert.equal(result.status, 0, `launcher should exit 0; stderr: ${result.stderr}`);
  assert.equal(fs.existsSync(sentinel), true, "fake hook should have executed via pwd fallback");
  assert.equal(fs.readFileSync(sentinel, "utf8").trim(), "pwd fallback");
});

test("launcher (behavioural): logs missing-script + exits 0 when the script is absent", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-launcher-miss-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Do NOT create .memory/src/scripts/hooks/session-start.sh — the
  // launcher should fall through to its log-and-exit-0 branch.
  const cmd = pickCommand("session-start.sh");
  const result = runLauncher(cmd, dir, { CLAUDE_PROJECT_DIR: dir });

  assert.equal(result.status, 0, `launcher must exit 0 even on miss; stderr: ${result.stderr}`);
  const logPath = path.join(dir, ".memory/src/.hook-launcher.log");
  assert.equal(fs.existsSync(logPath), true, "missing-script log file should exist");
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(log, /hook-launcher: missing/, "log should contain miss line");
  assert.match(log, /session-start\.sh/, "log should name the missing script");
});

test("launcher (behavioural): every hook in the claude template runs end-to-end", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-launcher-all-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const hookDir = path.join(dir, ".memory/src/scripts/hooks");
  fs.mkdirSync(hookDir, { recursive: true });

  const cmds = loadLauncherCommands(CLAUDE_TEMPLATE);
  for (const scriptName of Object.keys(cmds)) {
    const sentinel = path.join(dir, `${scriptName}.flag`);
    const fakeHook = path.join(hookDir, scriptName);
    fs.writeFileSync(fakeHook, `#!/usr/bin/env bash\necho "${scriptName}" > "${sentinel}"\n`);
    fs.chmodSync(fakeHook, 0o755);

    const result = runLauncher(cmds[scriptName], os.tmpdir(), { CLAUDE_PROJECT_DIR: dir });
    assert.equal(
      result.status,
      0,
      `${scriptName}: launcher should exit 0; stderr: ${result.stderr}`,
    );
    assert.equal(
      fs.existsSync(sentinel),
      true,
      `${scriptName}: fake hook should have written its sentinel`,
    );
  }
});

// ---------------------------------------------------------------------------
// Fire-confirmation breadcrumb: the .sh launchers append to .hook-runs.log
// ---------------------------------------------------------------------------

test("fire-confirmation: each shipped .sh launcher writes a line to .hook-runs.log when invoked", (t) => {
  // The shipped .sh launchers (scripts/hooks/*.sh) write a fire-line to
  // .hook-runs.log at .memory/src/<HERE>/../../.hook-runs.log — i.e. at
  // the .memory/src/ root. We invoke each .sh directly (NOT through the
  // bash-c launcher) and assert the log line appears.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-runs-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Stage a fake .memory/src tree so the launcher resolves
  // LOG_DIR=$SCRIPT_DIR/../../ -> our tmpdir, and writes to
  // <tmpdir>/.hook-runs.log.
  const scriptDir = path.join(dir, "scripts/hooks");
  fs.mkdirSync(scriptDir, { recursive: true });

  // Stage stub .mjs files so the `node ...` line at the end of each
  // .sh doesn't fail (we're only testing the launcher's log line).
  for (const stub of ["session-start.mjs", "flush.mjs", "exit-plan-mode.mjs"]) {
    fs.writeFileSync(path.join(scriptDir, stub), "// no-op stub for launcher test\n");
  }

  // Copy the shipped .sh files in so the script's SCRIPT_DIR resolves
  // to our tmpdir's scripts/hooks, putting the log at <tmpdir>/.hook-runs.log.
  for (const name of ["session-start.sh", "pre-compact.sh", "post-compact.sh", "session-end.sh", "exit-plan-mode.sh"]) {
    const src = path.resolve("scripts/hooks", name);
    const dst = path.join(scriptDir, name);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
  }

  // Invoke each launcher; assert log line accumulates.
  for (const name of ["session-start.sh", "pre-compact.sh", "post-compact.sh", "session-end.sh", "exit-plan-mode.sh"]) {
    const r = spawnSync(path.join(scriptDir, name), [], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: "utf8",
      timeout: 5000,
    });
    // Some launchers will fail when the stub .mjs returns nothing
    // useful; we DO NOT assert on status here because the goal is the
    // log line, which is written BEFORE `node ...` runs.
    void r;
  }

  const logPath = path.join(dir, ".hook-runs.log");
  assert.equal(fs.existsSync(logPath), true, ".hook-runs.log should exist after launcher invocation");
  const log = fs.readFileSync(logPath, "utf8");
  for (const name of ["session-start.sh", "pre-compact.sh", "post-compact.sh", "session-end.sh", "exit-plan-mode.sh"]) {
    assert.match(log, new RegExp(`${name} invoked`), `${name} should have written its fire-line`);
  }
});
