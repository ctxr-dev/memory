#!/usr/bin/env bash
# Plan-capture write-path smoke. Companion to scripts/mcp-smoke.sh.
#
# scripts/mcp-smoke.sh is intentionally read-only (no writes that would
# dirty the user's dataset). This script exercises the full write path
# the ExitPlanMode hook depends on:
#   1. Find any pre-existing plan-mcp-smoke-*.md to clean up later.
#   2. Build a synthetic PostToolUse hook payload with approved=true and
#      a known plan body.
#   3. Pipe it to ./scripts/hooks/exit-plan-mode.mjs.
#   4. Assert stderr matches "wrote plan-mcp-smoke-... to plans".
#   5. Verify the doc landed via list_datasets / find-by-name.
#   6. Optionally clean up via the new delete_document MCP tool.
#
# Requires: bridge container running, DIFY_DATASET_PLANS_ID bound, Dify
# API key configured. Skips with a clear message if any prereq missing.
#
# Run this AFTER ./memory/scripts/dify-setup.sh during install
# verification to confirm the auto-capture path works end-to-end against
# YOUR Dify. Pass --keep to leave the smoke doc in place; default is
# --cleanup (delete after verifying).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

CLEANUP=1
for arg in "$@"; do
  case "$arg" in
    --keep)    CLEANUP=0 ;;
    --cleanup) CLEANUP=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "plan-capture-smoke: unknown arg '$arg' (use --keep or --cleanup)" >&2
      exit 2
      ;;
  esac
done

load_memory_env

container_name="${MCP_CONTAINER_NAME:-$(read_env_value MCP_CONTAINER_NAME "$MEMORY_ENV" 2>/dev/null || true)}"
if [ -z "$container_name" ] || [ "$container_name" = "__MEMORY_SERVER_NAME__" ]; then
  echo "plan-capture-smoke SKIP: MCP_CONTAINER_NAME not set in memory/.env." >&2
  echo "  Run ./memory/bootstrap.sh --slug <project-slug> first." >&2
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "plan-capture-smoke SKIP: docker is not available on PATH." >&2
  exit 0
fi

if ! docker inspect -f '{{.State.Running}}' "$container_name" >/dev/null 2>&1; then
  echo "plan-capture-smoke SKIP: $container_name is not running. Start it with ./memory/scripts/up.sh." >&2
  exit 0
fi

plans_id="${DIFY_DATASET_PLANS_ID:-$(read_env_value DIFY_DATASET_PLANS_ID "$MEMORY_ENV" 2>/dev/null || true)}"
if [ -z "$plans_id" ]; then
  echo "plan-capture-smoke SKIP: DIFY_DATASET_PLANS_ID is empty. Run ./memory/scripts/dify-setup.sh to bind the plans slot." >&2
  exit 0
fi

# Use a unique title so concurrent CI runs don't trample each other; the
# slugify will fold this to plan-mcp-smoke-<timestamp>-<pid>.md.
ts="$(date -u +%Y%m%d-%H%M%S)"
title="MCP smoke ${ts} pid${$}"
expected_slug="$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g')"
expected_name="plan-${expected_slug}.md"

stderr_file="$(mktemp)"
trap 'rm -f "$stderr_file"' EXIT

echo "plan-capture-smoke: writing ${expected_name} ..."
if ! printf '%s\n' "{\"tool_response\":{\"approved\":true},\"tool_input\":{\"plan\":\"# ${title}\\n\\nPlan body for end-to-end smoke. Safe to delete.\"}}" \
  | node "$SCRIPT_DIR/hooks/exit-plan-mode.mjs" 2> "$stderr_file"; then
  echo "plan-capture-smoke FAIL: hook exited non-zero (must always exit 0)." >&2
  cat "$stderr_file" >&2
  exit 1
fi

if ! grep -qE "wrote ${expected_name} to plans" "$stderr_file"; then
  echo "plan-capture-smoke FAIL: expected 'wrote ${expected_name} to plans' on stderr; got:" >&2
  cat "$stderr_file" >&2
  exit 1
fi
echo "plan-capture-smoke: hook reported success."

# Verify the doc actually exists in Dify via the bridge CLI.
echo "plan-capture-smoke: looking up ${expected_name} in Dify ..."
found_json="$(docker exec -i "$container_name" node src/memory-cli.js find-by-name --datasetId plans --name "$expected_name")"
doc_id="$(printf '%s' "$found_json" | node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
const j = JSON.parse(raw);
if (!j?.document?.id) { process.exit(1); }
process.stdout.write(j.document.id);
' || true)"

if [ -z "$doc_id" ]; then
  echo "plan-capture-smoke FAIL: hook claimed success but find-by-name returned no doc." >&2
  echo "  bridge response: $found_json" >&2
  exit 1
fi
echo "plan-capture-smoke: doc id ${doc_id} confirmed in Dify."

if [ "$CLEANUP" -eq 1 ]; then
  echo "plan-capture-smoke: deleting smoke doc ..."
  if ! docker exec -i "$container_name" node src/memory-cli.js delete --datasetId plans --documentId "$doc_id" >/dev/null; then
    echo "plan-capture-smoke WARN: cleanup delete failed; smoke doc ${expected_name} (id ${doc_id}) still present in Dify." >&2
    echo "  Delete manually via the Dify UI if you want it gone." >&2
    exit 1
  fi
  echo "plan-capture-smoke: cleanup complete."
else
  echo "plan-capture-smoke: --keep set; smoke doc ${expected_name} (id ${doc_id}) left in place."
fi

echo "plan-capture-smoke: PASS"
