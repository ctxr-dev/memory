// Lock the crash-safe writer used by the self-healing state (entity state, issues
// index, issue reports, front-truncated attempts log): it writes the full
// content, overwrites in place, leaves no temp file, and honors the mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "../scripts/lib/atomic-write.mjs";

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"));
  return { dir, file: path.join(dir, "state.json") };
}

test("writes full content and overwrites in place; no temp leftover", () => {
  const { dir, file } = tmp();
  try {
    writeFileAtomic(file, "first\n");
    assert.equal(fs.readFileSync(file, "utf8"), "first\n");
    const big = "x".repeat(200_000);
    writeFileAtomic(file, big);
    assert.equal(fs.readFileSync(file, "utf8"), big, "large payload written in full (no short-write truncation)");
    // No sibling temp files left behind.
    const leftover = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftover, [], "no .tmp leftover");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("accepts a Buffer and honors an explicit mode", () => {
  const { dir, file } = tmp();
  try {
    writeFileAtomic(file, Buffer.from("buf-data"), { mode: 0o600 });
    assert.equal(fs.readFileSync(file, "utf8"), "buf-data");
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, "exact mode bits forced past umask");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("throws (and leaves no temp) when the target directory does not exist", () => {
  const { dir } = tmp();
  try {
    assert.throws(() => writeFileAtomic(path.join(dir, "nope", "x.json"), "data"));
    assert.ok(!fs.existsSync(path.join(dir, "nope")), "did not create the missing dir");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
