import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTRUCTIONS as HOST, buildSessionStartContext } from "../scripts/lib/discipline.mjs";
import { INSTRUCTIONS as BRIDGE } from "../mcp-server/src/discipline.js";

// Drift guard: the Dockerised bridge cannot import scripts/lib, so the discipline
// is duplicated. The host copy and the container copy MUST stay byte-identical.
test("INSTRUCTIONS is byte-identical between host and bridge copies", () => {
  assert.equal(HOST, BRIDGE);
});

test("INSTRUCTIONS encodes the attempt-first routing rule", () => {
  assert.match(HOST, /health check IS the attempt/);
  assert.match(HOST, /ALWAYS try the save FIRST/);
  assert.match(HOST, /ONLY after an actual tool-call error/);
  assert.match(HOST, /the shared RAG store is the DEFAULT, NOT your client's local file memory/);
  assert.match(HOST, /call save_lesson BEFORE replying/);
});

test("buildSessionStartContext names the server and embeds the discipline", () => {
  const ctx = buildSessionStartContext({ serverName: "test-server", compileTriggered: true });
  assert.match(ctx, /test-server/);
  assert.ok(ctx.includes(HOST), "context embeds the shared INSTRUCTIONS verbatim");
  assert.match(ctx, /Compile was triggered/);
});

test("buildSessionStartContext reports the skipped-compile branch", () => {
  const ctx = buildSessionStartContext({ serverName: "s", compileTriggered: false });
  assert.match(ctx, /Compile was already attempted today/);
});
