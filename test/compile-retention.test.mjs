// Unit tests for the pure active-window classifier in scripts/compile.mjs.
// These lock the "keep both" model: today's doc accumulates (never touched),
// completed in-window days are promoted exactly once then kept enabled, and
// dailies older than MEMORY_DAILY_ACTIVE_DAYS are retired (disabled).

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyDaily, daysBetweenUtc } from "../scripts/compile.mjs";

const TODAY = "2026-05-25";
const ACTIVE = 7;

function classify(name, promoted = []) {
  return classifyDaily({
    name,
    todayUtc: TODAY,
    activeDays: ACTIVE,
    promotedSet: new Set(promoted),
  });
}

test("daysBetweenUtc: whole-day differences", () => {
  assert.equal(daysBetweenUtc("2026-05-25", "2026-05-25"), 0);
  assert.equal(daysBetweenUtc("2026-05-24", "2026-05-25"), 1);
  assert.equal(daysBetweenUtc("2026-05-18", "2026-05-25"), 7);
  assert.equal(daysBetweenUtc("2026-05-17", "2026-05-25"), 8);
  // Crosses a month boundary.
  assert.equal(daysBetweenUtc("2026-04-30", "2026-05-01"), 1);
  assert.ok(Number.isNaN(daysBetweenUtc("not-a-date", "2026-05-25")));
});

test("today's doc is left alone (still accumulating)", () => {
  assert.equal(classify("daily-2026-05-25.md"), "skip-today");
});

test("future-dated doc (clock skew) is treated as skip-today", () => {
  assert.equal(classify("daily-2026-05-26.md"), "skip-today");
});

test("yesterday (in window, not promoted) -> promote", () => {
  assert.equal(classify("daily-2026-05-24.md"), "promote");
});

test("yesterday already promoted -> skip-promoted (kept enabled)", () => {
  assert.equal(classify("daily-2026-05-24.md", ["daily-2026-05-24.md"]), "skip-promoted");
});

test("last in-window day (age == activeDays - 1) -> promote", () => {
  // 6 days old with a 7-day window (today + previous 6): still active.
  assert.equal(classify("daily-2026-05-19.md"), "promote");
});

test("reaching window age (age == activeDays) -> retire", () => {
  // 7 days old with a 7-day window: aged out.
  assert.equal(classify("daily-2026-05-18.md"), "retire");
});

test("MEMORY_DAILY_ACTIVE_DAYS=1 keeps only today; yesterday retires", () => {
  assert.equal(
    classifyDaily({ name: "daily-2026-05-25.md", todayUtc: TODAY, activeDays: 1, promotedSet: new Set() }),
    "skip-today",
  );
  assert.equal(
    classifyDaily({ name: "daily-2026-05-24.md", todayUtc: TODAY, activeDays: 1, promotedSet: new Set() }),
    "retire",
  );
});

test("aged-out doc retires regardless of promoted state", () => {
  assert.equal(classify("daily-2026-05-01.md"), "retire");
  assert.equal(classify("daily-2026-05-01.md", ["daily-2026-05-01.md"]), "retire");
});

test("legacy per-event name is classified by its date", () => {
  // Same date as yesterday -> in window -> promote.
  assert.equal(classify("daily-2026-05-24-130405678.md"), "promote");
  // Old legacy doc -> retire.
  assert.equal(classify("daily-2026-05-01-090000000.md"), "retire");
});

test("unparseable name is never auto-disabled (skip-today)", () => {
  assert.equal(classify("not-a-daily.md"), "skip-today");
});
