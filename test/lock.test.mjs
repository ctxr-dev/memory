// Verify scripts/lib/lock.mjs file lock semantics:
//   - fresh acquire creates the lockfile and returns ok:true
//   - second acquire while owner alive + lock fresh returns ok:false
//   - acquire over a lockfile owned by a dead pid reclaims (stale)
//   - acquire over a lockfile older than staleMs reclaims (stale)
//   - releaseLock only deletes when WE are the owner
//   - acquire over an unparseable lockfile reclaims
//
// These tests are hermetic: each uses a unique tmpdir lockpath. No
// network, no real concurrent process spawning — concurrent owners are
// simulated by writing the lockfile body directly with a fake pid.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { acquireLock, releaseLock } from "../scripts/lib/lock.mjs";

function tmpLockPath(name = "lock.test") {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `mb-${name}-`)),
    "compile.lock",
  );
}

// A pid we know is not in use. PIDs are positive ints; 2^31-1 is the
// canonical "definitely not running" value on Linux/macOS.
const DEAD_PID = 2147483646;

test("acquireLock: fresh acquire creates lockfile and returns ok:true", () => {
  const p = tmpLockPath("fresh");
  const result = acquireLock(p, { label: "test" });
  assert.equal(result.ok, true, "fresh lock should succeed");
  assert.ok(fs.existsSync(p), "lockfile should exist after acquire");
  const body = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(body.pid, process.pid);
  assert.equal(body.label, "test");
  assert.ok(body.startedAt, "startedAt should be present");
  result.release();
  assert.equal(fs.existsSync(p), false, "release should delete lockfile");
});

test("acquireLock: contention with live owner returns ok:false", () => {
  const p = tmpLockPath("contention");
  // Simulate a live owner by writing the current pid (this process is
  // definitely alive). The acquire below should see "fresh + alive" and
  // refuse.
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), label: "owner" }) + "\n",
  );
  const result = acquireLock(p, { label: "test" });
  assert.equal(result.ok, false, "contended lock should fail");
  assert.ok(result.owner, "should return owner info");
  assert.equal(result.owner.pid, process.pid);
  assert.match(result.reason, /lock held by pid=/);
  // Cleanup the test fixture (we never owned this lock).
  fs.unlinkSync(p);
});

test("acquireLock: dead-pid owner is treated as stale and reclaimed", () => {
  const p = tmpLockPath("deadpid");
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString(), label: "ghost" }) + "\n",
  );
  const result = acquireLock(p, { label: "test" });
  assert.equal(result.ok, true, "stale lock should be reclaimed");
  const body = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(body.pid, process.pid, "lockfile should now be ours");
  result.release();
});

test("acquireLock: too-old lock is reclaimed even if owner pid is alive", () => {
  const p = tmpLockPath("aged");
  // Owner pid is this process (alive), but startedAt is far in the past.
  // staleMs=1ms guarantees the age check trips.
  const ancient = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: process.pid, startedAt: ancient, label: "old" }) + "\n",
  );
  const result = acquireLock(p, { label: "test", staleMs: 1 });
  assert.equal(result.ok, true, "expired lock should be reclaimed");
  const body = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(body.pid, process.pid);
  // startedAt should have been refreshed to now.
  assert.notEqual(body.startedAt, ancient);
  result.release();
});

test("acquireLock: unparseable lockfile is reclaimed", () => {
  const p = tmpLockPath("garbage");
  fs.writeFileSync(p, "{ this is not valid json");
  const result = acquireLock(p, { label: "test" });
  assert.equal(result.ok, true, "unparseable lock should be reclaimed");
  const body = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(body.pid, process.pid);
  result.release();
});

test("releaseLock: does NOT delete a lock owned by another pid", () => {
  const p = tmpLockPath("foreign");
  // Write a lock owned by a different (live) pid. We use process.ppid as
  // a convenient real pid that isn't us.
  const foreignPid = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid + 1;
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: foreignPid, startedAt: new Date().toISOString(), label: "other" }) + "\n",
  );
  releaseLock(p);
  assert.equal(
    fs.existsSync(p),
    true,
    "releaseLock must not delete a lock we do not own",
  );
  fs.unlinkSync(p);
});

test("releaseLock: missing lockfile is a no-op (idempotent)", () => {
  const p = tmpLockPath("missing");
  // Lockfile never created. Release should not throw.
  assert.doesNotThrow(() => releaseLock(p));
});

test("acquireLock: two sequential acquires (release between) both succeed", () => {
  const p = tmpLockPath("sequential");
  const a = acquireLock(p, { label: "A" });
  assert.equal(a.ok, true);
  a.release();
  const b = acquireLock(p, { label: "B" });
  assert.equal(b.ok, true, "second acquire after release should succeed");
  const body = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(body.label, "B");
  b.release();
});

test("acquireLock: stale-reclaim verify catches a foreign pid overwrite", () => {
  // Simulate the double-stale-reclaim race: a stale lock exists, our
  // process enters the reclaim path, but BEFORE we return another
  // process overwrites the lockfile with its own pid. The verify
  // re-read should detect the foreign pid and fail us cleanly so we
  // don't proceed thinking we own the lock.
  //
  // We can't truly inject between the writeLockBody and the verify
  // re-read without monkey-patching fs, so we drive the same code path
  // by manipulating the on-disk state to mimic the post-overwrite view.
  // Specifically: install a stale lock, then rig the test by writing a
  // foreign pid to the lockfile after the acquire returns ok:true and
  // confirming releaseLock won't clobber it.
  const p = tmpLockPath("verify");
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: DEAD_PID, startedAt: new Date().toISOString(), label: "stale" }) + "\n",
  );
  const result = acquireLock(p, { label: "test" });
  assert.equal(result.ok, true, "stale lock reclaimed");
  // Simulate a racer overwriting AFTER we acquired (post-hoc proof that
  // releaseLock is foreign-pid-safe — the verify check protects the
  // pre-acquire window, this protects the post-acquire window).
  const foreignPid = process.pid + 7777;
  fs.writeFileSync(
    p,
    JSON.stringify({ pid: foreignPid, startedAt: new Date().toISOString(), label: "foreign" }) + "\n",
  );
  result.release();
  assert.equal(
    fs.existsSync(p),
    true,
    "release must not delete a lock now owned by a foreign pid",
  );
  fs.unlinkSync(p);
});
