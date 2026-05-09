// Drift guard: scripts/lib/slug.mjs (host runtime) and
// mcp-server/src/slug.js (container runtime) MUST produce byte-identical
// definitions for the 5 shared functions: slugify, timestampUtc,
// dailyDocName, knowledgeDocName, lessonDocName.
//
// If you change one, change the other — multiple audits flagged silent
// drift between these two files as a regression-prone vector.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const HOST_PATH = path.join(REPO, "scripts/lib/slug.mjs");
const CONTAINER_PATH = path.join(REPO, "mcp-server/src/slug.js");

const SHARED_FUNCTIONS = [
  "slugify",
  "timestampUtc",
  "dailyDocName",
  "knowledgeDocName",
  "lessonDocName",
];

// Extract the source of a single `export function NAME(...) { ... }`
// declaration by brace-matching from the opening { to its matching }.
function extractFunction(source, name) {
  const re = new RegExp(`export\\s+function\\s+${name}\\b[^{]*\\{`);
  const start = source.search(re);
  if (start < 0) return null;
  const openIdx = source.indexOf("{", start);
  if (openIdx < 0) return null;
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

test("source files exist", () => {
  assert.ok(fs.existsSync(HOST_PATH), `missing ${HOST_PATH}`);
  assert.ok(fs.existsSync(CONTAINER_PATH), `missing ${CONTAINER_PATH}`);
});

const hostSrc = fs.readFileSync(HOST_PATH, "utf8");
const containerSrc = fs.readFileSync(CONTAINER_PATH, "utf8");

for (const fn of SHARED_FUNCTIONS) {
  test(`shared function '${fn}' is byte-identical between host and container`, () => {
    const hostBody = extractFunction(hostSrc, fn);
    const containerBody = extractFunction(containerSrc, fn);
    assert.ok(hostBody, `host: failed to locate function '${fn}' in ${HOST_PATH}`);
    assert.ok(containerBody, `container: failed to locate function '${fn}' in ${CONTAINER_PATH}`);
    assert.equal(
      containerBody,
      hostBody,
      `Drift detected in '${fn}'. Host (${HOST_PATH}) and container (${CONTAINER_PATH}) must match exactly.\n--- HOST ---\n${hostBody}\n--- CONTAINER ---\n${containerBody}`,
    );
  });
}
