// Lock the bridge argv parser (mcp-server/src/cli-args.js parseArgs).
//
// Regression: a daily atom titled "--dry-run --force wiped state via ungated
// FORCE clear" produced a dedup search query that STARTS with "--". In the
// two-element `--query <value>` form the bridge could not tell the value from
// the next flag, so it read `--query` as a valueless boolean and rejected the
// call with "--query <string> is required" -- aborting the whole hourly compile
// and stranding 10 dailies. The fix is the `--key=value` form (emitted by the
// host's buildExecCliArgs), which the parser must accept verbatim even when the
// value itself starts with "--". The two-element and bare-boolean forms stay
// for backward-compat with shell callers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../mcp-server/src/cli-args.js";

test("parseArgs: --key=value takes everything after the first = verbatim", () => {
  const args = parseArgs(["search", "--query=hello world", "--datasetId=knowledge"]);
  assert.equal(args._[0], "search");
  assert.equal(args.query, "hello world");
  assert.equal(args.datasetId, "knowledge");
});

test("parseArgs: --key=value preserves a value that STARTS with -- (the incident)", () => {
  // The exact failing shape: the search query is a doc title beginning with --.
  const value = "--dry-run --force wiped state via ungated FORCE clear dry-run state cli";
  const args = parseArgs([
    "search",
    `--query=${value}`,
    "--datasetId=knowledge",
    "--limit=5",
  ]);
  assert.equal(args.query, value, "the dash-leading query survives intact");
  assert.equal(args.datasetId, "knowledge");
  assert.equal(args.limit, "5");
});

test("parseArgs: --key=value splits only on the FIRST = (JSON / = in value survive)", () => {
  const json = '{"atom_type":"decision","note":"a=b=c"}';
  const args = parseArgs([`--metadata=${json}`, "--name=foo=bar"]);
  assert.equal(args.metadata, json);
  assert.equal(args.name, "foo=bar");
});

test("parseArgs: --key=  (empty after =) yields an empty-string value, not true", () => {
  const args = parseArgs(["--query="]);
  assert.equal(args.query, "");
});

test("parseArgs: two-element --key value form still works (backward-compat)", () => {
  const args = parseArgs(["disable", "--documentId", "doc1", "--datasetId", "ds1"]);
  assert.equal(args._[0], "disable");
  assert.equal(args.documentId, "doc1");
  assert.equal(args.datasetId, "ds1");
});

test("parseArgs: bare --flag (next token absent or another flag) is boolean true", () => {
  const trailing = parseArgs(["update-doc-metadata", "--replace"]);
  assert.equal(trailing.replace, true);
  const followed = parseArgs(["--replace", "--datasetId=ds1"]);
  assert.equal(followed.replace, true);
  assert.equal(followed.datasetId, "ds1");
});

test("parseArgs: a two-element value that starts with -- is (still) read as boolean", () => {
  // This is the unavoidable ambiguity the `=` form exists to avoid. We assert it
  // so the limitation is documented and locked: callers needing a dash-leading
  // value MUST use --key=value (which buildExecCliArgs always does).
  const args = parseArgs(["search", "--query", "--datasetId", "ds1"]);
  assert.equal(args.query, true, "two-element dash-leading value cannot be expressed");
  assert.equal(args.datasetId, "ds1");
});

test("parseArgs: positional (non-flag) tokens accumulate in _", () => {
  const args = parseArgs(["list", "extra1", "--datasetId=ds1", "extra2"]);
  assert.deepEqual(args._, ["list", "extra1", "extra2"]);
  assert.equal(args.datasetId, "ds1");
});
