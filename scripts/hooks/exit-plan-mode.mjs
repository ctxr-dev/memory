import fs from "node:fs";
import { slugify } from "../lib/slug.mjs";
import { saveDocument, DifyBridgeUnavailable } from "../lib/dify-write.mjs";
import { envValue, slotEnvKey } from "../lib/env.mjs";

const PLANS_SLOT = "plans";

export function extractTitle(body) {
  const text = String(body ?? "");
  const h1 = text.match(/^#\s+(.+?)\s*$/m);
  if (h1) return h1[1].trim();
  const firstLine = text.split("\n").map((l) => l.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : "untitled";
}

export function planDocSpec(hookInput) {
  const tool_input = hookInput?.tool_input ?? {};
  const tool_response = hookInput?.tool_response ?? {};
  if (tool_response.approved !== true) return { skip: "not-approved" };
  const plan = String(tool_input.plan ?? "").trim();
  if (!plan) return { skip: "empty-plan" };
  const title = extractTitle(plan);
  const slug = slugify(title);
  // project_module is intentionally OMITTED, not set to "unknown": a literal
  // "unknown" pollutes downstream filters (`recall_lessons` filtering by
  // exact project_module would treat every captured plan as the same module
  // forever, indistinguishable from genuine unknowns). Empty/missing fields
  // are simply not matched. atom_type=plan + task_type=planning are enough
  // for retrieval; project_module can be added later via update_memory if a
  // user wants per-module plan filtering.
  return {
    name: `plan-${slug}.md`,
    text: plan,
    datasetSlot: PLANS_SLOT,
    metadata: { atom_type: "plan", task_type: "planning" },
  };
}

function readStdin() {
  // When invoked outside a hook context (a curious user runs the .sh
  // directly with no pipe) fd 0 is a TTY and readFileSync(0) blocks until
  // Ctrl-D. Short-circuit to "" so manual debug runs are non-blocking.
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const hookInput = parseJsonMaybe(readStdin()) || {};
  const spec = planDocSpec(hookInput);
  if (spec.skip) {
    console.error(`exit-plan-mode: skipped (${spec.skip})`);
    return;
  }

  // Refuse cleanly if the plans slot isn't bound, so the user gets a useful
  // skip message instead of a generic Dify 4xx. Mirrors flush.mjs preflight.
  // The bridge does the same resolution server-side; checking host-side
  // avoids a 200ms+ docker exec round-trip when the slot is obviously
  // unbound and produces a more actionable error message.
  const envKey = slotEnvKey(PLANS_SLOT);
  const boundId = envValue(envKey, "");
  if (!boundId) {
    console.error(
      `exit-plan-mode: skipped (plans slot not bound; ${envKey} empty, run ./memory/scripts/dify-setup.sh)`,
    );
    return;
  }

  try {
    const result = await saveDocument({
      name: spec.name,
      text: spec.text,
      datasetId: spec.datasetSlot,
      metadata: spec.metadata,
    });
    const note = result?.metadataError ? ` (metadata: ${result.metadataError})` : "";
    console.error(`exit-plan-mode: wrote ${spec.name} to ${spec.datasetSlot}${note}`);
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) {
      console.error(`exit-plan-mode: skipped (bridge unavailable: ${err.message})`);
      return;
    }
    throw err;
  }
}

// Run main() only when invoked as a CLI; importing the module (e.g. from
// the test file) MUST NOT trigger stdin reads or bridge calls.
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  try {
    await main();
  } catch (err) {
    console.error(`exit-plan-mode: failed: ${err instanceof Error ? err.message : String(err)}`);
    // Hooks must never block the agent. Exit 0 even on unexpected errors;
    // the stderr message is the breadcrumb for diagnosis.
    process.exit(0);
  }
}
