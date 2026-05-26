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
//
// Each test uses its OWN temp module file so tests never share mutable state
// (node:test may run files concurrently and within-file ordering should not be
// relied on for filesystem races).

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-hot-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function freshModule(name, body) {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, body);
  return { abs, url: pathToFileURL(abs).href };
}

test("a cache-busted re-import observes a changed module", async () => {
  const m = freshModule("reimport.mjs", "export const tag = () => 'one';\n");
  const first = await import(`${m.url}?v=0`);
  assert.equal(first.tag(), "one");

  fs.writeFileSync(m.abs, "export const tag = () => 'two';\n"); // simulate git pull
  const cached = await import(`${m.url}?v=0`);
  assert.equal(cached.tag(), "one", "same specifier is served from the ESM cache");

  const reloaded = await import(`${m.url}?v=1`);
  assert.equal(reloaded.tag(), "two", "new specifier re-evaluates the module");
});

test("let-rebinding routes existing call sites to the reloaded module", async () => {
  const m = freshModule("rebind.mjs", "export const tag = () => 'A';\n");
  let tag; // reassigned by loadLib(); a closure (handler) reads it at call time
  let seq = 0;
  const loadLib = async () => {
    ({ tag } = await import(`${m.url}?v=${seq}`));
  };
  const handler = () => tag(); // captures the `let`, not a snapshot

  await loadLib();
  assert.equal(handler(), "A");

  fs.writeFileSync(m.abs, "export const tag = () => 'B';\n");
  seq = 1; // what the debounced fs.watch handler does
  await loadLib();
  assert.equal(handler(), "B", "the unchanged call site now runs the reloaded code");
});

test("loadLib-style validation rejects a module missing an expected export", async () => {
  // Mirrors the bridge guard: stage exports, verify none are undefined, only
  // then commit. A module missing an export must abort the reload, not
  // half-apply undefined bindings.
  const m = freshModule("partial.mjs", "export const a = () => 1;\n"); // `b` intentionally absent
  const ns = await import(`${m.url}?v=0`);
  const next = { a: ns.a, b: ns.b };
  let committed = false;
  try {
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) throw new Error(`missing export '${k}'`);
    }
    committed = true;
  } catch (err) {
    assert.match(err.message, /missing export 'b'/);
  }
  assert.equal(committed, false, "reload aborts when an export is missing");
});
