// Lock the always-record renderers in scripts/hooks/flush.mjs.
//
// The whole point of the rework is that the worker NEVER exits silently: it
// records atoms on success, a visible nothing-durable marker when the
// distiller finds nothing, or the raw (redacted) context as a fallback when
// distillation fails (so an outage never loses the conversation). Importing
// flush.mjs is safe: its hook/worker entry is guarded behind a direct-invoke
// check, so importing only exposes the pure renderers.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderNothingMarker,
  renderRawFallback,
  renderDailyDocument,
} from "../scripts/hooks/flush.mjs";

const source = {
  sessionId: "abcd1234-5678-90ab-cdef-1234567890ab",
  cwd: "/Users/dev/work/project-x",
  hookEvent: "PreCompact",
  body: "### User\n\nfix the thing\n\n### Assistant\n\ndone",
  turnCount: 2,
};

test("renderNothingMarker: visible record, zero atoms, not pending promotion", () => {
  const doc = renderNothingMarker(source);
  assert.match(doc, /atom_count: 0/);
  assert.match(doc, /pending_promotion: false/);
  assert.match(doc, /outcome: nothing-durable/);
  assert.match(doc, /session_short: abcd1234/);
  assert.match(doc, /found nothing durable/i);
});

test("renderRawFallback: preserves the raw body inside an untrusted fence", () => {
  const doc = renderRawFallback({ source, reason: "claude exited 1: API Error 400" });
  assert.match(doc, /outcome: distillation-failed/);
  assert.match(doc, /pending_promotion: true/);
  assert.match(doc, /<!-- BEGIN UNTRUSTED MEMORY BODY -->/);
  assert.match(doc, /<!-- END UNTRUSTED MEMORY BODY -->/);
  assert.ok(doc.includes(source.body), "raw context must be preserved for a later compile pass");
  assert.match(doc, /distiller_error:.*400/);
});

test("renderDailyDocument: renders atoms with metadata and pending promotion", () => {
  const atoms = [
    {
      type: "decision",
      title: "Use X",
      body: "because Y",
      tags: ["infra"],
      metadata: { project_module: "infra", language: "", task_type: "", error_pattern: "" },
    },
  ];
  const doc = renderDailyDocument({ atoms, source });
  assert.match(doc, /atom_count: 1/);
  assert.match(doc, /pending_promotion: true/);
  assert.match(doc, /### Atom · decision · Use X/);
  assert.match(doc, /- metadata: \{"project_module":"infra"/);
});
