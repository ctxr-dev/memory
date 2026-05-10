import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { slugify } from "../lib/slug.mjs";
import { saveDocument, DifyBridgeUnavailable } from "../lib/dify-write.mjs";
import { envValue, slotEnvKey } from "../lib/env.mjs";
import { redact } from "../lib/redact.mjs";

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
  const raw = tool_input.plan;
  // Missing field is semantically empty, not a type error.
  if (raw == null) return { skip: "empty-plan" };
  // Reject non-string plan bodies. Coercing { foo: 1 } would yield
  // "[object Object]" and persist garbage; better to skip cleanly so the
  // user sees the breadcrumb and can investigate the upstream payload.
  if (typeof raw !== "string") return { skip: "non-string-plan" };
  // Redact secrets BEFORE slugifying or persisting. flush.mjs runs the
  // same gate on transcripts; the plan body is just as exposed (the user
  // could paste an API key into the title or steps). redact() is
  // idempotent so it costs nothing if the plan is clean.
  const plan = redact(raw).trim();
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
    const notes = [];
    if (result?.metadataError) notes.push(`metadata error: ${result.metadataError}`);
    // metadataResult.warning fires when the dataset has no matching
    // per-doc fields (user skipped dify-setup.sh schema install OR
    // created the dataset via the create_dataset MCP tool). Surface it
    // so the user knows the doc landed but is unfilterable until they
    // re-run the wizard. updateDocumentMetadata returns the warning
    // inside metadataResult, not metadataError.
    if (result?.metadataResult?.warning) {
      notes.push(`metadata warning: ${result.metadataResult.warning}`);
    }
    const note = notes.length ? ` (${notes.join("; ")})` : "";
    console.error(`exit-plan-mode: wrote ${spec.name} to ${spec.datasetSlot}${note}`);
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) {
      // Detect the stale-bridge-env case: bridge is up and reachable but
      // its in-process env doesn't see the slot binding because it was
      // started before the user added DIFY_DATASET_PLANS_ID. dify-setup.sh
      // restarts the bridge after binding, but a user who edited memory/.env
      // by hand wouldn't have. Give the actionable hint.
      const msg = err.message || "";
      const looksLikeStaleEnv = /Dataset\s+'?plans'?\s+is not configured|requireDifyWriteConfig/i.test(msg);
      const hint = looksLikeStaleEnv
        ? " — try ./memory/scripts/up.sh memory_mcp to refresh the bridge env"
        : "";
      console.error(`exit-plan-mode: skipped (bridge unavailable: ${msg})${hint}`);
      return;
    }
    throw err;
  }
}

// Run main() only when invoked as a CLI; importing the module (e.g. from
// the test file) MUST NOT trigger stdin reads or bridge calls.
// pathToFileURL is the documented robust path: handles Windows drive
// letters, UNC paths, percent-encoding, and matches import.meta.url's
// exact normalisation. Manual `new URL("file://" + argv[1])` works on
// macOS by accidental URL-parser leniency but is fragile on Windows.
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
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
