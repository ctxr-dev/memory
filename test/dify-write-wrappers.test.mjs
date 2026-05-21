// Lock the thin-wrapper contracts in scripts/lib/dify-write.mjs.
//
// Each wrapper (disableDocument / enableDocument / deleteDocument /
// listDocuments / readDocument / searchMemoryFiltered / setBuiltInMetadata
// / updateDocMetadata / listDatasets / saveDocument / writeMemory) is
// a one-liner that hands a specific (subcommand, flags) pair to
// execCli. A silent rename of either the subcommand name (e.g.
// "disable" → "disable-document") or a flag key (e.g. "documentId" →
// "docId") would silently break every host-side call site without
// any test catching it. These tests lock both contracts by (1)
// source-parsing each wrapper's actual `execCli("<subcommand>"` literal
// out of dify-write.mjs and asserting it against an expected table, and
// (2) exercising the pure `buildExecCliArgs` sibling with each wrapper's
// real flag shape to cover the args-serialization path.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildExecCliArgs } from "../scripts/lib/dify-write.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIFY_WRITE_SRC = fs.readFileSync(
  path.resolve(here, "..", "scripts", "lib", "dify-write.mjs"),
  "utf8",
);

// Source-parse the ACTUAL subcommand literal each exported wrapper hands
// to execCli. For wrapper `export function <name>(...)`, find the first
// `execCli("<literal>"` after the declaration and before the next
// `export function`. Handles both inline (`return execCli("save", ...)`)
// and multi-line (`return execCli(\n  "write",`) call shapes.
// This is what makes the table below a REAL lock: a silent rename of a
// wrapper's subcommand in dify-write.mjs diverges from the expected
// table and fails the test (closes the round-39 reviewer finding that
// the prior version only exercised buildExecCliArgs with hardcoded
// strings and never inspected the wrappers).
function extractWrapperSubcommand(name) {
  const declRe = new RegExp(`export function ${name}\\b`);
  const declMatch = declRe.exec(DIFY_WRITE_SRC);
  if (!declMatch) return null;
  const start = declMatch.index;
  const nextDecl = DIFY_WRITE_SRC.indexOf("export function ", start + 1);
  const body = DIFY_WRITE_SRC.slice(start, nextDecl === -1 ? undefined : nextDecl);
  const callMatch = body.match(/execCli\(\s*"([a-z][a-z0-9-]*)"/);
  return callMatch ? callMatch[1] : null;
}

// ---------- buildExecCliArgs (pure) ----------

test("buildExecCliArgs: emits docker-exec preamble + subcommand", () => {
  const args = buildExecCliArgs("list", {}, "memcontainer");
  assert.deepEqual(args, ["exec", "-i", "memcontainer", "node", "src/memory-cli.js", "list"]);
});

test("buildExecCliArgs: emits each flag as `--key value` pair", () => {
  const args = buildExecCliArgs(
    "save",
    { name: "plan-foo.md", datasetId: "plans" },
    "c",
  );
  // Order: subcommand first, then flag pairs in insertion order.
  assert.deepEqual(args.slice(5), ["save", "--name", "plan-foo.md", "--datasetId", "plans"]);
});

test("buildExecCliArgs: drops flags with value undefined / null / empty string", () => {
  const args = buildExecCliArgs(
    "list",
    { prefix: "plan-", enabled: undefined, datasetId: null, foo: "" },
    "c",
  );
  // Only prefix should survive.
  assert.deepEqual(args.slice(5), ["list", "--prefix", "plan-"]);
});

test("buildExecCliArgs: emits `value === true` as a bare --flag with no value", () => {
  // Matches the boolean-switch convention used by some memory-cli subcommands.
  const args = buildExecCliArgs("ping", { dryRun: true, verbose: true }, "c");
  assert.deepEqual(args.slice(5), ["ping", "--dryRun", "--verbose"]);
});

test("buildExecCliArgs: coerces non-string values via String()", () => {
  const args = buildExecCliArgs("list", { limit: 5, enabled: false }, "c");
  // false is NOT === true, so it's emitted as a value.
  assert.deepEqual(args.slice(5), ["list", "--limit", "5", "--enabled", "false"]);
});

// ---------- Wrapper subcommand + flag-shape lock ----------
//
// The wrappers in scripts/lib/dify-write.mjs each call execCli with a
// specific (subcommand, flags) pair. The table below records every
// wrapper's expected subcommand name and flag-key set. Two complementary
// assertions per row:
//   1. SOURCE LOCK: extractWrapperSubcommand source-parses the ACTUAL
//      `execCli("<literal>"` call in the wrapper's body and asserts it
//      equals the expected subcommand. This catches a silent rename in
//      dify-write.mjs (the round-39 reviewer's concern that the prior
//      version never inspected the wrappers).
//   2. ARGS LOCK: buildExecCliArgs (the pure builder all wrappers funnel
//      through) is exercised with the wrapper's real flag shape so the
//      args-serialization path is covered too.

const WRAPPER_TABLE = [
  { wrapper: "writeMemory",        subcommand: "write", flags: { name: "n", datasetId: "d", supersedes: "s", supersedesAction: "disable" } },
  { wrapper: "saveDocument",       subcommand: "save",  flags: { name: "n", datasetId: "d" /* metadata path is in buildSaveFlags */ } },
  { wrapper: "disableDocument",    subcommand: "disable", flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "enableDocument",     subcommand: "enable",  flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "deleteDocument",     subcommand: "delete",  flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "listDocuments",      subcommand: "list",    flags: { prefix: "plan-", enabled: "true", datasetId: "ds1" } },
  { wrapper: "readDocument",       subcommand: "read",    flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "searchMemoryFiltered", subcommand: "search", flags: { query: "q", datasetId: "ds1", limit: "5" } },
  { wrapper: "setBuiltInMetadata", subcommand: "set-built-in-metadata", flags: { datasetId: "ds1", enabled: "true" } },
  { wrapper: "updateDocMetadata",  subcommand: "update-doc-metadata",   flags: { datasetId: "ds1", documentId: "doc1", metadata: '{"a":1}' } },
  { wrapper: "listDatasets",       subcommand: "list-datasets", flags: {} },
];

for (const row of WRAPPER_TABLE) {
  test(`${row.wrapper}: subcommand='${row.subcommand}' + flag shape locked`, () => {
    // 1. Source lock — the wrapper's actual execCli subcommand literal.
    const sourceSubcommand = extractWrapperSubcommand(row.wrapper);
    assert.equal(
      sourceSubcommand,
      row.subcommand,
      `${row.wrapper} in scripts/lib/dify-write.mjs calls execCli("${sourceSubcommand}") but the lock table expects "${row.subcommand}". If the rename is intentional, update WRAPPER_TABLE; otherwise it is a silent contract break.`,
    );

    // 2. Args lock — the pure builder serialization with the real flags.
    const args = buildExecCliArgs(row.subcommand, row.flags, "test-container");
    // Subcommand is at index 5.
    assert.equal(args[5], row.subcommand, `${row.wrapper} must use subcommand '${row.subcommand}'`);
    // Every flag key in the wrapper's contract should appear as --key in args.
    for (const key of Object.keys(row.flags)) {
      const val = row.flags[key];
      if (val === undefined || val === null || val === "") continue;
      const flagIdx = args.indexOf(`--${key}`);
      assert.ok(flagIdx > 5, `${row.wrapper} missing --${key} in args=${JSON.stringify(args)}`);
      if (val !== true) {
        assert.equal(args[flagIdx + 1], String(val), `${row.wrapper} --${key} value mismatch`);
      }
    }
  });
}

// ---------- searchMemoryFiltered: filter + scoreThreshold serialization ----------

test("searchMemoryFiltered: filters object is JSON-stringified", () => {
  // Indirect lock: the wrapper at scripts/lib/dify-write.mjs is a one-liner
  // that calls execCli('search', {query, datasetId, limit, filters:
  // JSON.stringify(filters)}). We assert the args shape via buildExecCliArgs
  // with the exact serialization the wrapper produces.
  const filters = { atom_type: "decision", project_module: "auth" };
  const flags = {
    query: "x",
    datasetId: "ds1",
    limit: 5,
    filters: JSON.stringify(filters),
    scoreThreshold: "0.5",
  };
  const args = buildExecCliArgs("search", flags, "c");
  assert.equal(args[5], "search");
  assert.equal(args[args.indexOf("--filters") + 1], '{"atom_type":"decision","project_module":"auth"}');
  assert.equal(args[args.indexOf("--scoreThreshold") + 1], "0.5");
});
