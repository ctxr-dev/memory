import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The bridge MCP server hot-reloads its logic by dynamic-importing the logic
// modules with a cache-busting query (`?v=N`) on file change and reassigning
// module-scoped `let` bindings that the tool handlers reference. This locks the
// core mechanism: a fresh `import(... ?v=N)` after an edit observes the NEW
// exports, and reassigning a `let` makes existing call sites use the new code
// without restarting the stdio process or editing the 60+ call sites.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-hot-"));
const mod = path.join(dir, "reloadable.js");
const url = pathToFileURL(mod).href;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a cache-busted re-import observes a changed module", async () => {
  fs.writeFileSync(mod, "export const tag = () => 'one';\n");
  const first = await import(`${url}?v=0`);
  assert.equal(first.tag(), "one");

  fs.writeFileSync(mod, "export const tag = () => 'two';\n"); // simulate git pull
  const cached = await import(`${url}?v=0`);
  assert.equal(cached.tag(), "one", "same specifier is served from the ESM cache");

  const reloaded = await import(`${url}?v=1`);
  assert.equal(reloaded.tag(), "two", "new specifier re-evaluates the module");
});

test("let-rebinding routes existing call sites to the reloaded module", async () => {
  // Mirror the bridge: a module-scoped `let` the 'handlers' call through.
  let tag; // reassigned by loadLib(); a closure (handler) reads it at call time
  let seq = 0;
  const loadLib = async () => {
    ({ tag } = await import(`${url}?v=${seq}`));
  };
  const handler = () => tag(); // captures the `let`, not a snapshot

  fs.writeFileSync(mod, "export const tag = () => 'A';\n");
  seq = 100;
  await loadLib();
  assert.equal(handler(), "A");

  fs.writeFileSync(mod, "export const tag = () => 'B';\n");
  seq = 101; // what the debounced fs.watch handler does
  await loadLib();
  assert.equal(handler(), "B", "the unchanged call site now runs the reloaded code");
});
