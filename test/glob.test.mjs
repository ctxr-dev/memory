// findFiles + relPathToDocName via a synthetic temp-dir tree. Hermetic:
// no reliance on the host filesystem layout. Cleans up tempdirs in t.after.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findFiles,
  relPathToDocName,
  defaultGlobs,
  defaultIgnore,
} from "../mcp-server/src/glob.js";

function mkTempTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memboil-glob-"));
  return root;
}

function w(root, rel, content = "x") {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

test("defaultGlobs: returns a fresh array each call", () => {
  const a = defaultGlobs();
  const b = defaultGlobs();
  assert.notEqual(a, b, "should not return the same reference");
  assert.deepEqual(a, b);
  // Mutating one must not affect the next call.
  a.push("garbage");
  assert.notDeepEqual(defaultGlobs(), a);
});

test("defaultIgnore: returns a fresh array each call", () => {
  const a = defaultIgnore();
  const b = defaultIgnore();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

test("findFiles: finds markdown via default include globs", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "README.md", "# hello");
  w(root, "docs/guide.md", "guide");
  w(root, "notes/scratch.txt", "scratch");
  w(root, "code.js", "ignored");

  const out = findFiles(root);
  const rels = out.map((e) => e.relPath).sort();
  assert.deepEqual(rels, ["README.md", "docs/guide.md", "notes/scratch.txt"]);
});

test("findFiles: prunes default-ignored directories (.git, node_modules, vendor, memory)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, ".git/config.md", "secret");
  w(root, "node_modules/dep/readme.md", "x");
  w(root, "vendor/dify/api.md", "x");
  w(root, "memory/notes.md", "x");
  w(root, ".memory/state.md", "x");
  w(root, "dist/out.md", "x");
  w(root, "build/out.md", "x");
  w(root, ".next/page.md", "x");
  w(root, ".cache/page.md", "x");
  w(root, ".turbo/log.md", "x");

  const out = findFiles(root);
  const rels = out.map((e) => e.relPath);
  assert.deepEqual(rels, ["kept.md"], `unexpected results: ${JSON.stringify(rels)}`);
});

test("findFiles: skips symlinks (cannot escape root)", (t) => {
  const root = mkTempTree();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "memboil-out-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  w(root, "real.md", "real");
  w(outside, "secret.md", "secret");

  // Create a symlink inside the root pointing to the outside dir.
  try {
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
  } catch (err) {
    // On platforms where symlinks aren't permitted, skip the assertion
    // about symlink contents (still verify the rest).
    if (err && err.code === "EPERM") {
      const out = findFiles(root);
      assert.deepEqual(out.map((e) => e.relPath), ["real.md"]);
      return;
    }
    throw err;
  }

  const out = findFiles(root);
  const rels = out.map((e) => e.relPath);
  assert.deepEqual(rels, ["real.md"], `symlink content leaked: ${JSON.stringify(rels)}`);
});

test("findFiles: returns size and mtime for each entry", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  w(root, "a.md", "hello");

  const out = findFiles(root);
  assert.equal(out.length, 1);
  assert.equal(out[0].size, 5);
  assert.match(out[0].mtime || "", /T.*Z/);
  assert.equal(out[0].relPath, "a.md");
  assert.equal(out[0].absPath, path.join(root, "a.md"));
});

test("findFiles: respects custom include + ignore", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "a.js", "1");
  w(root, "b.js", "1");
  w(root, "skip/c.js", "1");
  w(root, "x.md", "1");

  const out = findFiles(root, { include: ["**/*.js"], ignore: ["skip/**"] });
  const rels = out.map((e) => e.relPath).sort();
  assert.deepEqual(rels, ["a.js", "b.js"]);
});

test("findFiles: nonexistent root -> empty list (no throw)", () => {
  const out = findFiles(path.join(os.tmpdir(), "memboil-does-not-exist-xyz-12345"));
  assert.deepEqual(out, []);
});

test("findFiles: results sorted by relPath ascending", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  w(root, "z.md", "z");
  w(root, "a.md", "a");
  w(root, "m.md", "m");

  const rels = findFiles(root).map((e) => e.relPath);
  assert.deepEqual(rels, ["a.md", "m.md", "z.md"]);
});

// ---------- relPathToDocName ----------

test("relPathToDocName: replaces / with _", () => {
  assert.equal(relPathToDocName("docs/api/usage.md"), "docs_api_usage.md");
});

test("relPathToDocName: normalises Windows backslashes", () => {
  assert.equal(relPathToDocName("docs\\api\\usage.md"), "docs_api_usage.md");
});

test("relPathToDocName: top-level file unchanged", () => {
  assert.equal(relPathToDocName("README.md"), "README.md");
});

test("relPathToDocName: handles empty/non-string defensively", () => {
  assert.equal(relPathToDocName(""), "");
  assert.equal(relPathToDocName(123), "123");
});
