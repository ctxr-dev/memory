// Lock the memory-cli.js dispatch table.
//
// The bridge's CLI entry point dispatches `node src/memory-cli.js <sub>`
// via a switch on `sub`. Each `case "<name>":` arm maps a subcommand
// name to a handler function. A silent rename (e.g. `"enable"` →
// `"enable-document"`) or a missing case (a new MCP tool registered
// without its CLI arm) would silently break every host-side caller in
// scripts/lib/dify-write.mjs and produce confusing runtime errors at
// the user's hook execution time.
//
// Since memory-cli.js top-levels its dispatch (no exported function),
// we lock the table by source-parsing the file: extract the
// `case "<name>":` literals, the handler-function literals, the usage
// string, and assert all three agree with a canonical expected set.
// Tests fail at compile-time if a maintainer renames a subcommand
// without updating the lock, making the change visible in review.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(here, "..", "mcp-server", "src", "memory-cli.js");
const cliSource = fs.readFileSync(CLI_PATH, "utf8");

// Canonical expected set of subcommands. This MUST match the cases
// in memory-cli.js's main dispatch switch. Adding a new MCP tool that
// also exposes a CLI subcommand requires adding a row here AND adding
// the `case "<name>":` line AND extending the usage string.
const EXPECTED_SUBCOMMANDS = [
  "search",
  "write",
  "save",
  "list",
  "read",
  "disable",
  "enable",
  "delete",
  "list-datasets",
  "create-dataset",
  "get-config",
  "list-embedding-models",
  "find-by-name",
  "scan",
  "absorb",
  "list-metadata-fields",
  "create-metadata-field",
  "set-built-in-metadata",
  "update-doc-metadata",
];

function extractCaseLiterals(source) {
  const out = new Set();
  const re = /case\s+"([a-z][a-z0-9-]*)"\s*:\s*result\s*=\s*await\s+(\w+Cmd)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.add(m[1]);
  }
  return out;
}

function extractHandlerNames(source) {
  const out = new Map();
  const re = /case\s+"([a-z][a-z0-9-]*)"\s*:\s*result\s*=\s*await\s+(\w+Cmd)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.set(m[1], m[2]);
  }
  return out;
}

test("memory-cli dispatch: every expected subcommand has a `case` arm", () => {
  const cases = extractCaseLiterals(cliSource);
  for (const sub of EXPECTED_SUBCOMMANDS) {
    assert.ok(cases.has(sub), `memory-cli.js missing dispatch case for subcommand '${sub}'`);
  }
});

test("memory-cli dispatch: no UNEXPECTED `case` arms (no orphaned subcommand)", () => {
  const cases = extractCaseLiterals(cliSource);
  for (const sub of cases) {
    assert.ok(
      EXPECTED_SUBCOMMANDS.includes(sub),
      `memory-cli.js has dispatch case for unexpected subcommand '${sub}'; either add to EXPECTED_SUBCOMMANDS or remove the case`,
    );
  }
});

test("memory-cli dispatch: subcommand-to-handler-name mapping is canonical", () => {
  // Catches a wiring error like `case "disable": result = await enableCmd(...)`.
  // The naming convention is `<subcommand-without-hyphens>Cmd`, e.g.
  // "list-datasets" → "listDatasetsCmd", "set-built-in-metadata" →
  // "setBuiltInMetadataCmd".
  const handlers = extractHandlerNames(cliSource);
  function expectedHandler(sub) {
    // kebab-case → camelCase + "Cmd"
    const camel = sub.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return `${camel}Cmd`;
  }
  for (const sub of EXPECTED_SUBCOMMANDS) {
    const got = handlers.get(sub);
    const want = expectedHandler(sub);
    assert.equal(got, want, `'${sub}' case should call '${want}', got '${got}'`);
  }
});

test("memory-cli dispatch: usage string lists every dispatch case", () => {
  // The usage string in the `default:` branch tells the user what's
  // valid. Keeping it in sync with the dispatch table prevents the
  // "unknown subcommand: X — try one of <stale list>" UX bug.
  const cases = extractCaseLiterals(cliSource);
  const usageMatch = cliSource.match(/Usage: memory-cli\.js <([^>]+)>/);
  assert.ok(usageMatch, "memory-cli.js usage string not found");
  const usageList = usageMatch[1].split("|").map((s) => s.trim());
  for (const sub of cases) {
    assert.ok(usageList.includes(sub), `subcommand '${sub}' missing from usage string`);
  }
  for (const sub of usageList) {
    assert.ok(cases.has(sub), `usage string lists '${sub}' but no dispatch case exists`);
  }
});

test("memory-cli dispatch: count locked at " + EXPECTED_SUBCOMMANDS.length + " (alert on additions)", () => {
  const cases = extractCaseLiterals(cliSource);
  assert.equal(
    cases.size,
    EXPECTED_SUBCOMMANDS.length,
    `memory-cli.js has ${cases.size} dispatch cases; expected ${EXPECTED_SUBCOMMANDS.length}. If you added a new subcommand, update EXPECTED_SUBCOMMANDS in this test file.`,
  );
});
