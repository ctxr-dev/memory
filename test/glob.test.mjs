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
  mergeIgnore,
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

test("mergeIgnore: caller patterns are ADDED to defaults, never replace them", () => {
  const merged = mergeIgnore(["secrets/**", "private.md"]);
  // Defaults must be present
  assert.ok(merged.includes("**/node_modules"), "defaults must survive merge");
  assert.ok(merged.includes("**/.venv"), "defaults must survive merge");
  // User patterns are appended
  assert.ok(merged.includes("secrets/**"));
  assert.ok(merged.includes("private.md"));
});

test("mergeIgnore: empty/null/undefined caller input keeps defaults intact", () => {
  for (const input of [undefined, null, [], [""], [null]]) {
    const merged = mergeIgnore(input);
    assert.ok(merged.includes("**/node_modules"), `defaults missing for input=${JSON.stringify(input)}`);
  }
});

test("findFiles: caller-supplied ignore is ADDITIVE; defaults always apply", (t) => {
  // Even with the user passing a custom ignore list, dependency / vendor
  // dirs must NOT leak into the result. This is the contract that lets
  // callers add restrictions without losing protection.
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, "node_modules/leaked.md", "should be ignored regardless");
  w(root, "secret.md", "user wants to skip this");

  const out = findFiles(root, { ignore: ["secret.md"] });
  const rels = out.map((e) => e.relPath).sort();
  assert.deepEqual(rels, ["kept.md"], `unexpected: ${JSON.stringify(rels)}`);
});

test("findFiles: prunes JS/TS ecosystem dirs at any depth (node_modules, .next, .turbo, .yarn, bower_components, jspm_packages, .svelte-kit, .vercel, coverage)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  for (const dir of ["node_modules", ".next", ".turbo", ".yarn", "bower_components", "jspm_packages", ".svelte-kit", ".vercel", "coverage", ".nyc_output", ".parcel-cache"]) {
    w(root, `${dir}/leak.md`, "x");
    w(root, `nested/${dir}/leak.md`, "x");
  }
  const out = findFiles(root);
  const rels = out.map((e) => e.relPath);
  assert.deepEqual(rels, ["kept.md"], `JS leak: ${JSON.stringify(rels)}`);
});

test("findFiles: prunes Python ecosystem dirs at any depth (__pycache__, .venv, venv, .tox, .pytest_cache, .mypy_cache, .ruff_cache, .ipynb_checkpoints, *.egg-info)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  for (const dir of ["__pycache__", ".venv", "venv", ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".pyre", ".ipynb_checkpoints", "site-packages", "myproject.egg-info"]) {
    w(root, `${dir}/leak.md`, "x");
    w(root, `pkg/${dir}/leak.md`, "x");
  }
  const out = findFiles(root);
  const rels = out.map((e) => e.relPath);
  assert.deepEqual(rels, ["kept.md"], `Python leak: ${JSON.stringify(rels)}`);
});

test("findFiles: prunes Rust/Java/Maven/Scala target dir at any depth", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, "target/leak.md", "x");
  w(root, "subcrate/target/leak.md", "x");
  w(root, "module-a/target/classes/leak.md", "x");

  const out = findFiles(root);
  assert.deepEqual(out.map((e) => e.relPath), ["kept.md"]);
});

test("findFiles: prunes iOS / Xcode dirs at any depth (DerivedData, Pods, Carthage, xcuserdata, .swiftpm, .build)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  for (const dir of ["DerivedData", "Pods", "Carthage", "xcuserdata", ".swiftpm", ".build"]) {
    w(root, `${dir}/leak.md`, "x");
    w(root, `MyApp.xcodeproj/${dir}/leak.md`, "x");
  }
  const out = findFiles(root);
  assert.deepEqual(out.map((e) => e.relPath), ["kept.md"]);
});

test("findFiles: prunes .NET dirs (obj) but NOT bin (intentional)", (t) => {
  // bin/ is intentionally NOT in the default ignore list because many
  // projects keep shell scripts and committed binaries under bin/.
  // The default include list (markdown/text) already excludes .NET
  // build artifacts, so leaving bin/ walkable is safe in practice.
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, "obj/leak.md", "x");
  w(root, "Project/obj/leak.md", "x");
  w(root, "bin/notes.md", "this would be kept (bin not ignored)");

  const out = findFiles(root);
  const rels = out.map((e) => e.relPath).sort();
  assert.ok(rels.includes("kept.md"));
  assert.ok(rels.includes("bin/notes.md"));
  assert.ok(!rels.some((r) => r.startsWith("obj/") || r.includes("/obj/")));
});

test("findFiles: prunes Elixir / Erlang dirs (_build, deps, .elixir_ls)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, "_build/leak.md", "x");
  w(root, "deps/foo/leak.md", "x");
  w(root, ".elixir_ls/leak.md", "x");
  w(root, "apps/myapp/_build/leak.md", "x");
  w(root, "apps/myapp/deps/leak.md", "x");

  const out = findFiles(root);
  assert.deepEqual(out.map((e) => e.relPath), ["kept.md"]);
});

test("findFiles: prunes Haskell dirs (.stack-work, dist-newstyle)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, ".stack-work/leak.md", "x");
  w(root, "dist-newstyle/leak.md", "x");
  w(root, "subpkg/.stack-work/leak.md", "x");

  const out = findFiles(root);
  assert.deepEqual(out.map((e) => e.relPath), ["kept.md"]);
});

test("findFiles: prunes Terraform / Vagrant / Serverless state dirs", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, ".terraform/leak.md", "x");
  w(root, "modules/vpc/.terraform/leak.md", "x");
  w(root, ".serverless/leak.md", "x");
  w(root, ".vagrant/leak.md", "x");
  w(root, "state.tfstate", "{}");
  w(root, "state.tfstate.backup", "{}");

  const out = findFiles(root, { include: ["**/*"] });
  const rels = out.map((e) => e.relPath).sort();
  assert.deepEqual(rels, ["kept.md"], `Terraform leak: ${JSON.stringify(rels)}`);
});

test("findFiles: prunes IDE state (.idea, .vs) but keeps .vscode (intentional)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, ".idea/workspace.md", "x");
  w(root, ".vs/launch.md", "x");
  w(root, ".vscode/notes.md", "kept by design");

  const out = findFiles(root);
  const rels = out.map((e) => e.relPath).sort();
  assert.deepEqual(rels, [".vscode/notes.md", "kept.md"]);
});

test("findFiles: ignores backup/swap files (~, .swp, .swo, .bak, .orig, .#*)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, "kept.md~", "vim backup");
  w(root, ".kept.md.swp", "vim swap");
  w(root, ".kept.md.swo", "vim swap2");
  w(root, "kept.md.bak", "backup");
  w(root, "kept.md.orig", "merge orig");
  w(root, ".#kept.md", "emacs lock");

  const out = findFiles(root, { include: ["**/*"] });
  const rels = out.map((e) => e.relPath).sort();
  assert.deepEqual(rels, ["kept.md"], `backup leak: ${JSON.stringify(rels)}`);
});

test("findFiles: ignores OS junk (.DS_Store, Thumbs.db, desktop.ini)", (t) => {
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, ".DS_Store", "macos");
  w(root, "subdir/.DS_Store", "macos nested");
  w(root, "Thumbs.db", "windows");
  w(root, "subdir/desktop.ini", "windows nested");

  const out = findFiles(root, { include: ["**/*"] });
  assert.deepEqual(out.map((e) => e.relPath), ["kept.md"]);
});

test("findFiles: ignores .lock and .log files at any depth", (t) => {
  // Defence-in-depth check. The default include list (markdown/text)
  // already excludes .lock/.log by extension, but a custom include like
  // `**/*` would otherwise pull these in. The ignore list must catch
  // them at any nesting level so absorb_files cannot ingest e.g.
  // `.compile.lock` written by an in-flight compile run.
  const root = mkTempTree();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  w(root, "kept.md", "x");
  w(root, ".compile.lock", '{"pid":123}');
  w(root, "subdir/other.lock", "x");
  w(root, "compile.log", "x");
  w(root, "subdir/error.log", "x");

  const out = findFiles(root, { include: ["**/*"] });
  const rels = out.map((e) => e.relPath).sort();
  assert.deepEqual(rels, ["kept.md"], `lock/log leaked: ${JSON.stringify(rels)}`);
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
