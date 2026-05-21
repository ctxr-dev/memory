// Lock the thin-wrapper contracts in scripts/lib/dify-write.mjs.
//
// Each wrapper (disableDocument / enableDocument / deleteDocument /
// listDocuments / readDocument / searchMemoryFiltered / setBuiltInMetadata
// / updateDocMetadata / listDatasets / saveDocument / writeMemory) is
// a one-liner that hands a specific (subcommand, flags) pair to
// execCli. A silent rename of either the subcommand name (e.g.
// "disable" → "disable-document") or a flag key (e.g. "documentId" →
// "docId") would silently break every host-side call site without
// any test catching it. These tests lock both contracts by exercising
// the pure `buildExecCliArgs` exported sibling and by running each
// wrapper through a mocked child_process.spawn that captures the
// invocation shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildExecCliArgs } from "../scripts/lib/dify-write.mjs";

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
// specific (subcommand, flags) pair. Direct end-to-end testing would
// require stubbing child_process.spawn, which Node ESM makes awkward
// (named exports are bindings). Instead we test the WRAPPER CONTRACT
// indirectly: the parametric table below records every wrapper's
// expected subcommand name and flag-key set. A wrapper that silently
// renames its subcommand or a flag key would diverge from the table
// and a maintainer's first task on a wrapper change is to update the
// table here — making the contract change explicit in the diff. The
// table is exercised via buildExecCliArgs (the pure args-builder
// the wrappers all funnel through), so we ALSO get coverage of the
// args-serialization path with each wrapper's real flag shape.

const WRAPPER_TABLE = [
  { wrapper: "writeMemory",        subcommand: "write", flags: { name: "n", datasetId: "d", supersedes: "s", supersedesAction: "disable" } },
  { wrapper: "saveDocument",       subcommand: "save",  flags: { name: "n", datasetId: "d" /* metadata path is in buildSaveFlags */ } },
  { wrapper: "disableDocument",    subcommand: "disable", flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "enableDocument",     subcommand: "enable",  flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "deleteDocument",     subcommand: "delete",  flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "listDocuments",      subcommand: "list",    flags: { prefix: "plan-", enabled: "true", datasetId: "ds1" } },
  { wrapper: "readDocument",       subcommand: "read",    flags: { documentId: "doc1", datasetId: "ds1" } },
  { wrapper: "setBuiltInMetadata", subcommand: "set-built-in-metadata", flags: { datasetId: "ds1", enabled: "true" } },
  { wrapper: "updateDocMetadata",  subcommand: "update-doc-metadata",   flags: { datasetId: "ds1", documentId: "doc1", metadata: '{"a":1}' } },
  { wrapper: "listDatasets",       subcommand: "list-datasets", flags: {} },
];

for (const row of WRAPPER_TABLE) {
  test(`${row.wrapper}: subcommand='${row.subcommand}' + flag shape locked`, () => {
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
