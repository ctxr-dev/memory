#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

docker exec -i "$container_name" node src/index.js <<'JSON' | tee "$output_file"
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_memory_config","arguments":{}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_memory","arguments":{"query":"memory smoke validation","maxResults":1}}}
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
if (!flushBound && !config.legacyWriteDatasetId) {
  fail(`Flush slot '${flushSlot}' has no configured id. Run ./memory/scripts/dify-setup.sh.`);
}
if (!compileBound && !config.legacyWriteDatasetId) {
  fail(`Compile slot '${compileSlot}' has no configured id. Run ./memory/scripts/dify-setup.sh.`);
}

const search = toolText(3);
if (Array.isArray(search.errors) && search.errors.length > 0) {
  fail(`Dify retrieval errors: ${JSON.stringify(search.errors)}`);
}

console.error(
  `MCP smoke OK: ${config.datasetIds.length} dataset(s), flush='${flushSlot}' compile='${compileSlot}'`,
);
NODE
