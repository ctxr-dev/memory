#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

load_memory_env
container_name="${MCP_CONTAINER_NAME:-$(read_env_value MCP_CONTAINER_NAME "$MEMORY_ENV" 2>/dev/null || true)}"
if [ -z "$container_name" ] || [ "$container_name" = "__MEMORY_SERVER_NAME__" ]; then
  echo "MCP smoke failed: MCP_CONTAINER_NAME not set in memory/.env (got '$container_name')." >&2
  echo "  Run ./memory/bootstrap.sh --slug <project-slug> first." >&2
  exit 1
fi
output_file="$(mktemp)"
trap 'rm -f "$output_file"' EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "MCP smoke failed: docker is not available on PATH." >&2
  exit 1
fi

if ! docker inspect -f '{{.State.Running}}' "$container_name" >/dev/null 2>&1; then
  echo "MCP smoke failed: $container_name is not running. Start the stack with ./memory/scripts/up.sh first." >&2
  exit 1
fi

# IDs 1-3: existing baseline (initialize, get_memory_config, search_memory).
# IDs 4-5: exercise the typed-pipeline tools so a regression in
# recall_lessons / metadata-filtered search surfaces here instead of in
# real-user incidents. Both are READ-ONLY (no save_lesson — that would
# dirty the user's dataset). The ladder for recall_lessons is probed
# with a deliberately-no-match query so success means "tool works and
# returns an empty/low-hit response without erroring".
# ID 6: audit_memory list-only walk across all slots. Verifies the tool
# registers, can call listAllDocuments per bound slot, and returns the
# documented { findings, summary, errors } envelope. Default classes
# argument exercises every finder pass without filtering, so a
# regression in any finder helper surfaces here.
docker exec -i "$container_name" node src/index.js <<'JSON' | tee "$output_file"
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_memory_config","arguments":{}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_memory","arguments":{"query":"memory smoke validation","maxResults":1}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_memory","arguments":{"query":"memory smoke filtered","maxResults":1,"filters":{"atom_type":"self-improvement-lesson"},"scoreThreshold":0.99}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"recall_lessons","arguments":{"query":"smoke probe with very specific phrase unlikely to match anything","project_module":"smoke","scoreThreshold":0.99,"maxResults":1,"includeKnowledge":false}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"audit_memory","arguments":{}}}
JSON

node - "$output_file" <<'NODE'
const fs = require("node:fs");

const filePath = process.argv[2];
const raw = fs.readFileSync(filePath, "utf8");
const messages = raw
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Non-JSON MCP output: ${line.slice(0, 200)}`);
    }
  });

function fail(message) {
  console.error(`MCP smoke failed: ${message}`);
  process.exit(1);
}

function response(id) {
  const message = messages.find((item) => item.id === id);
  if (!message) {
    fail(`missing response id ${id}`);
  }
  if (message.error) {
    fail(message.error.message || JSON.stringify(message.error));
  }
  return message.result;
}

function toolText(id) {
  const result = response(id);
  if (result?.isError) {
    const text = result.content?.map((item) => item.text).filter(Boolean).join("\n");
    fail(text || `tool call ${id} returned isError`);
  }

  const text = result?.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    fail(`tool call ${id} did not return text content`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`tool call ${id} returned invalid JSON text: ${error.message}`);
  }
}

response(1);
const config = toolText(2);
if (!config.apiKeyConfigured) {
  fail("DIFY_KNOWLEDGE_API_KEY is not configured in memory/.env");
}
if (!Array.isArray(config.datasetIds) || config.datasetIds.length === 0) {
  fail("No datasets configured. Run ./memory/scripts/dify-setup.sh to bind dataset slots (every DIFY_DATASET_<NAME>_ID line declares one).");
}
const flushSlot = config.flushDataset || "daily";
const compileSlot = config.compileDataset || "knowledge";
const slots = Array.isArray(config.datasetSlots) ? config.datasetSlots : [];
const flushBound = slots.find((s) => s.name === flushSlot)?.configuredId;
const compileBound = slots.find((s) => s.name === compileSlot)?.configuredId;
// Hard fail when neither the named slot NOR the legacy write dataset is set.
// When the named slot is unbound but legacy fallback exists, warn — the
// bridge will work, but writes will land on the legacy dataset, not the
// per-slot one the user thinks is wired.
if (!flushBound && !config.legacyWriteDatasetId) {
  fail(`Flush slot '${flushSlot}' has no configured id. Run ./memory/scripts/dify-setup.sh.`);
}
if (!compileBound && !config.legacyWriteDatasetId) {
  fail(`Compile slot '${compileSlot}' has no configured id. Run ./memory/scripts/dify-setup.sh.`);
}
let warnings = 0;
if (!flushBound && config.legacyWriteDatasetId) {
  warnings += 1;
  console.error(`MCP smoke WARNING: flush slot '${flushSlot}' is unbound; writes fall back to DIFY_WRITE_DATASET_ID=${config.legacyWriteDatasetId}. Run ./memory/scripts/dify-setup.sh to bind the slot.`);
}
if (!compileBound && config.legacyWriteDatasetId) {
  warnings += 1;
  console.error(`MCP smoke WARNING: compile slot '${compileSlot}' is unbound; writes fall back to DIFY_WRITE_DATASET_ID=${config.legacyWriteDatasetId}. Run ./memory/scripts/dify-setup.sh to bind the slot.`);
}

const search = toolText(3);
if (Array.isArray(search.errors) && search.errors.length > 0) {
  fail(`Dify retrieval errors: ${JSON.stringify(search.errors)}`);
}

// Filtered search (round-7 metadata_filtering_conditions path). Empty
// result is fine — what matters is the tool didn't throw on the filter
// shape and didn't return Dify-side errors.
const filteredSearch = toolText(4);
if (Array.isArray(filteredSearch.errors) && filteredSearch.errors.length > 0) {
  fail(`Filtered search errors: ${JSON.stringify(filteredSearch.errors)}`);
}

// recall_lessons (round-7 ladder + topK + dropOrder + final-cap
// semantics). High threshold + nonsense query forces empty result; we
// just need the tool to round-trip without throwing.
const recall = toolText(5);
if (recall.lessonDataset !== "self_improvement") {
  fail(`recall_lessons returned unexpected lessonDataset='${recall.lessonDataset}' (expected 'self_improvement')`);
}
if (typeof recall.totalRecords !== "number") {
  fail(`recall_lessons response missing totalRecords field`);
}
if (!Array.isArray(recall.records)) {
  fail(`recall_lessons response missing records array`);
}

// audit_memory list-only walk. The tool returns
//   { ok: true, findings: [...], summary: {...}, errors: [...] }
// when at least one slot is bound. Empty findings is fine — what
// matters is the registered tool surface, the listAllDocuments call
// per bound slot, and the documented envelope shape didn't regress.
const audit = toolText(6);
if (audit.ok !== true) {
  fail(`audit_memory returned ok=${audit.ok}; expected true`);
}
if (!Array.isArray(audit.findings)) {
  fail(`audit_memory response missing findings[] array`);
}
if (!audit.summary || typeof audit.summary !== "object") {
  fail(`audit_memory response missing summary{} object`);
}
if (!Array.isArray(audit.errors)) {
  fail(`audit_memory response missing errors[] array`);
}

const summary = `MCP smoke OK${warnings > 0 ? ` (with ${warnings} warning${warnings === 1 ? "" : "s"})` : ""}: ${config.datasetIds.length} dataset(s), flush='${flushSlot}' compile='${compileSlot}'; baseline + filtered search + recall_lessons + audit_memory round-trip clean`;
console.error(summary);
NODE
