// Lock the cron PATH builder: launchd/cron strip PATH to the minimal system
// dirs, hiding the provider CLIs (claude/codex) AND docker (the bridge
// transport). buildCronPath unions the live PATH + node's dir + curated CLI/
// docker dirs; augmentSpawnEnv heals a spawn env at runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildCronPath, augmentSpawnEnv, CURATED_CLI_DIRS } from "../mcp-server/src/cron-path.mjs";

test("buildCronPath: live PATH first, then node dir, then curated; deduped", () => {
  const out = buildCronPath({
    envPath: "/usr/bin:/bin",
    home: "/home/u",
    execPath: "/opt/node/bin/node",
  }).split(":");
  assert.equal(out[0], "/usr/bin", "live PATH wins (first)");
  assert.equal(out[1], "/bin");
  assert.ok(out.includes("/opt/node/bin"), "dirname(node) included for npm-shim CLIs");
  // Curated dirs present (tilde-expanded against home).
  assert.ok(out.includes("/home/u/.local/bin"), "~/.local/bin expanded");
  assert.ok(out.includes("/opt/homebrew/bin"));
  // docker shim dirs for the bridge transport.
  assert.ok(out.includes("/home/u/.rd/bin"), "Rancher docker shim dir");
  assert.ok(out.includes("/home/u/.colima/default/bin"), "Colima docker shim dir");
  // Dedup: no segment appears twice.
  assert.equal(out.length, new Set(out).size, "no duplicate segments");
});

test("buildCronPath: a curated dir already on the live PATH is not duplicated", () => {
  const out = buildCronPath({ envPath: "/opt/homebrew/bin:/usr/bin", home: "/h", execPath: "" }).split(":");
  assert.equal(out.filter((d) => d === "/opt/homebrew/bin").length, 1);
  assert.equal(out[0], "/opt/homebrew/bin", "live occurrence kept (first)");
});

test("buildCronPath: ~ entries dropped when home is unknown (a literal ~ never resolves)", () => {
  const out = buildCronPath({ envPath: "/usr/bin", home: "", execPath: "" }).split(":");
  assert.ok(!out.some((d) => d.includes("~")), "no literal ~ on PATH");
  assert.ok(!out.some((d) => d.endsWith("/.local/bin")), "home-relative curated dirs skipped without home");
  assert.ok(out.includes("/opt/homebrew/bin"), "absolute curated dirs still present");
});

test("augmentSpawnEnv: merges curated dirs into a minimal cron env; passes null through", () => {
  const merged = augmentSpawnEnv({ PATH: "/usr/bin:/bin", HOME: "/home/u", FOO: "bar" });
  assert.equal(merged.FOO, "bar", "other env preserved");
  const dirs = merged.PATH.split(":");
  assert.equal(dirs[0], "/usr/bin", "live PATH still first");
  assert.ok(dirs.includes("/home/u/.local/bin"), "curated dir appended");
  assert.ok(dirs.includes(path.dirname(process.execPath)), "this process's node dir appended");
  // null/undefined env (API provider that never spawns a CLI) passes through.
  assert.equal(augmentSpawnEnv(undefined), undefined);
  assert.equal(augmentSpawnEnv(null), null);
});

test("CURATED_CLI_DIRS: includes provider-CLI homes AND docker shim dirs", () => {
  for (const d of ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "~/.volta/bin", "~/.asdf/shims", "~/.cargo/bin", "~/.rd/bin", "~/.colima/default/bin"]) {
    assert.ok(CURATED_CLI_DIRS.includes(d), `curated dirs must include ${d}`);
  }
});
