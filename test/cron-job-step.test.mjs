// Lock the cron-job per-step timeout: a hung compile/consolidate must be killed
// and recorded as a failure, never left to run forever holding the cron lock.
// Regression (Copilot): runStep used spawnSync with no timeout.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runStep } from "../scripts/cron-job.mjs";

// A tiny script that sleeps far longer than the test timeout, so spawnSync must
// kill it. Written to a temp file (no Date.now/random in the script body).
function hangingScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-step-"));
  const p = path.join(dir, "hang.mjs");
  fs.writeFileSync(p, "setTimeout(() => {}, 60_000);\n");
  return { p, dir };
}

test("runStep: a step exceeding the timeout is killed and reported as a failure", () => {
  const { p, dir } = hangingScript();
  try {
    const r = runStep(p, [], { timeoutMs: 250 });
    assert.equal(r.ok, false, "a timed-out step is not ok");
    assert.equal(r.timedOut, true, "timedOut flag set");
    assert.match(r.stderr, /timed out after 250ms/, "stderr explains the timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runStep: a fast successful step is ok with exit 0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-step-ok-"));
  const p = path.join(dir, "ok.mjs");
  fs.writeFileSync(p, "process.exit(0);\n");
  try {
    const r = runStep(p, [], { timeoutMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.exit, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runStep: a non-zero exit is reported as a failure (not a timeout)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-step-fail-"));
  const p = path.join(dir, "fail.mjs");
  fs.writeFileSync(p, "process.stderr.write('boom\\n'); process.exit(3);\n");
  try {
    const r = runStep(p, [], { timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, false);
    assert.equal(r.exit, 3);
    assert.match(r.stderr, /boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
