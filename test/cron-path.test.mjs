// Lock the cron PATH builder: launchd/cron strip PATH to the minimal system
// dirs, hiding the provider CLIs (claude/codex) AND docker (the bridge
// transport). buildCronPath unions the live PATH + node's dir + curated CLI/
// docker dirs; augmentSpawnEnv heals a spawn env at runtime.
//
// PATH is built/split with path.delimiter (":" POSIX, ";" Windows) to match
// buildCronPath's cross-platform contract, so the tests are portable too.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildCronPath, augmentSpawnEnv, CURATED_CLI_DIRS } from "../mcp-server/src/cron-path.mjs";

const D = path.delimiter;
const join = (...dirs) => dirs.join(D);

test("buildCronPath: live PATH first, then node dir, then curated; deduped", () => {
  const out = buildCronPath({
    envPath: join("/usr/bin", "/bin"),
    home: "/home/u",
    execPath: path.join("/opt", "node", "bin", "node"),
  }).split(D);
  assert.equal(out[0], "/usr/bin", "live PATH wins (first)");
  assert.equal(out[1], "/bin");
  assert.ok(out.includes(path.join("/opt", "node", "bin")), "dirname(node) included for npm-shim CLIs");
  // Curated dirs present (tilde-expanded against home).
  assert.ok(out.includes(path.join("/home/u", ".local/bin")), "~/.local/bin expanded");
  assert.ok(out.includes("/opt/homebrew/bin"));
  // docker shim dirs for the bridge transport.
  assert.ok(out.includes(path.join("/home/u", ".rd/bin")), "Rancher docker shim dir");
  assert.ok(out.includes(path.join("/home/u", ".colima/default/bin")), "Colima docker shim dir");
  // Dedup: no segment appears twice.
  assert.equal(out.length, new Set(out).size, "no duplicate segments");
});

test("buildCronPath: a curated dir already on the live PATH is not duplicated", () => {
  const out = buildCronPath({ envPath: join("/opt/homebrew/bin", "/usr/bin"), home: "/h", execPath: "" }).split(D);
  assert.equal(out.filter((d) => d === "/opt/homebrew/bin").length, 1);
  assert.equal(out[0], "/opt/homebrew/bin", "live occurrence kept (first)");
});

test("buildCronPath: ~ entries dropped when home is unknown (a literal ~ never resolves)", () => {
  const out = buildCronPath({ envPath: "/usr/bin", home: "", execPath: "" }).split(D);
  assert.ok(!out.some((d) => d.includes("~")), "no literal ~ on PATH");
  assert.ok(!out.some((d) => d.endsWith(`${path.sep}.local${path.sep}bin`)), "home-relative curated dirs skipped without home");
  assert.ok(out.includes("/opt/homebrew/bin"), "absolute curated dirs still present");
});

test("augmentSpawnEnv: merges curated dirs into a minimal cron env; passes null through", () => {
  const merged = augmentSpawnEnv({ PATH: join("/usr/bin", "/bin"), HOME: "/home/u", FOO: "bar" });
  assert.equal(merged.FOO, "bar", "other env preserved");
  const dirs = merged.PATH.split(D);
  assert.equal(dirs[0], "/usr/bin", "live PATH still first");
  assert.ok(dirs.includes(path.join("/home/u", ".local/bin")), "curated dir appended");
  assert.ok(dirs.includes(path.dirname(process.execPath)), "this process's node dir appended");
  // null/undefined env (API provider that never spawns a CLI) passes through.
  assert.equal(augmentSpawnEnv(undefined), undefined);
  assert.equal(augmentSpawnEnv(null), null);
});

test("buildCronPath: whitespace-padded / empty segments are trimmed before dedup", () => {
  const out = buildCronPath({ envPath: join(" /usr/bin ", "/usr/bin", "  ", "/bin"), home: "/h", execPath: "" }).split(D);
  assert.ok(out.includes("/usr/bin"), "trailing/leading space trimmed to the real dir");
  assert.equal(out.filter((d) => d === "/usr/bin").length, 1, "padded duplicate collapsed");
  assert.ok(!out.includes(""), "no empty segment");
  assert.ok(!out.some((d) => /^\s|\s$/.test(d)), "no whitespace-padded segments");
});

test("augmentSpawnEnv: honors a Windows-style 'Path' key (preserves casing, keeps live PATH)", () => {
  const merged = augmentSpawnEnv({ Path: join("/usr/bin", "/bin"), HOME: "/home/u" });
  assert.equal(merged.PATH, undefined, "does not create a second PATH key");
  assert.ok(typeof merged.Path === "string", "writes back under the original 'Path' key");
  const dirs = merged.Path.split(D);
  assert.ok(dirs.includes("/usr/bin"), "live PATH from 'Path' is preserved, not dropped");
  assert.ok(dirs.includes(path.join("/home/u", ".local/bin")), "curated dirs still appended");
});

test("CURATED_CLI_DIRS: includes provider-CLI homes AND docker shim dirs", () => {
  for (const d of ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "~/.volta/bin", "~/.asdf/shims", "~/.cargo/bin", "~/.rd/bin", "~/.colima/default/bin"]) {
    assert.ok(CURATED_CLI_DIRS.includes(d), `curated dirs must include ${d}`);
  }
});
