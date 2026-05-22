#!/usr/bin/env bash
# Plan-capture write-path smoke. Companion to scripts/mcp-smoke.sh.
#
# scripts/mcp-smoke.sh is intentionally read-only (no writes that would
# dirty the user's dataset). This script exercises the full write path
# the ExitPlanMode hook depends on:
#   1. Build a synthetic PostToolUse hook payload with approved=true and
#      a unique title (timestamp + pid).
#   2. Pipe it to ./scripts/hooks/exit-plan-mode.mjs.
#   3. Assert stderr matches "wrote plan-mcp-smoke-... to plans".
#   4. Verify the doc landed via memory-cli `find-by-name`.
#   5. Optionally clean up via memory-cli `delete` and re-verify
#      via `find-by-name` that the doc is gone (covers the
#      delete_document MCP tool's underlying primitive end-to-end).
#
# Requires: bridge container running, DIFY_DATASET_PLANS_ID bound, Dify
# API key configured. Skips with a clear message if any prereq missing.
#
# Run this AFTER dify-setup.sh during install
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
  echo "plan-capture-smoke SKIP: MCP_CONTAINER_NAME not set in $MEMORY_ENV." >&2
  echo "  Run $MEMORY_DIR/bootstrap.sh --slug <project-slug> first." >&2
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "plan-capture-smoke SKIP: docker is not available on PATH." >&2
  exit 0
fi

if ! docker inspect -f '{{.State.Running}}' "$container_name" >/dev/null 2>&1; then
  echo "plan-capture-smoke SKIP: $container_name is not running. Start it with $MEMORY_DIR/scripts/up.sh." >&2
  exit 0
fi

plans_id="${DIFY_DATASET_PLANS_ID:-$(read_env_value DIFY_DATASET_PLANS_ID "$MEMORY_ENV" 2>/dev/null || true)}"
if [ -z "$plans_id" ]; then
  echo "plan-capture-smoke SKIP: DIFY_DATASET_PLANS_ID is empty. Run $MEMORY_DIR/scripts/dify-setup.sh to bind the plans slot." >&2
  exit 0
fi

# Preflight the Dify API key too: without it the hook's bridge call
# returns 401 and the smoke would fail HARD mid-run rather than skip
# cleanly. The header lists "Dify API key configured" as a prereq, so
# treat a missing key as a SKIP (parity with the checks above).
dify_key="${DIFY_KNOWLEDGE_API_KEY:-$(read_env_value DIFY_KNOWLEDGE_API_KEY "$MEMORY_ENV" 2>/dev/null || true)}"
if [ -z "$dify_key" ]; then
  echo "plan-capture-smoke SKIP: DIFY_KNOWLEDGE_API_KEY is empty in $MEMORY_ENV. Run $MEMORY_DIR/scripts/dify-setup.sh to configure Dify access." >&2
  exit 0
fi

# Use a unique title so concurrent CI runs don't trample each other; the
# slugify will fold this to plan-mcp-smoke-<timestamp>-<pid>.md.
ts="$(date -u +%Y%m%d-%H%M%S)"
title="MCP smoke ${ts} pid$$"
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

if ! grep -qF "wrote ${expected_name} to plans" "$stderr_file"; then
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
    echo "  Run delete_document(dataset='plans', documentId='${doc_id}') from any MCP client, or delete via Dify UI." >&2
    exit 1
  fi
  # Re-verify: the doc should be GONE. Catches a regression where
  # `delete` returns success but the doc actually persists (or where
  # the delete primitive shape changes silently). Also covers the
  # delete_document MCP tool's underlying primitive end-to-end.
  #
  # Retry loop: Dify's delete propagation can be momentarily async on a
  # heavily loaded indexer. 3 attempts × 500ms backoff covers the
  # observed race window without making the smoke flaky on slow CI.
  echo "plan-capture-smoke: re-verifying delete ..."
  post_doc=""
  for attempt in 1 2 3; do
    post_json="$(docker exec -i "$container_name" node src/memory-cli.js find-by-name --datasetId plans --name "$expected_name" || true)"
    post_doc="$(printf '%s' "$post_json" | node -e '
const fs = require("node:fs");
const raw = fs.readFileSync(0, "utf8");
try {
  const j = JSON.parse(raw);
  if (j?.document?.id) process.stdout.write(j.document.id);
} catch {}
' || true)"
    [ -z "$post_doc" ] && break
    [ "$attempt" -lt 3 ] && sleep 0.5
  done
  if [ -n "$post_doc" ]; then
    echo "plan-capture-smoke FAIL: delete returned success but find-by-name still returns doc id ${post_doc} after 3 retries." >&2
    echo "  Manual check: open the Dify UI and look in the plans dataset for ${expected_name}." >&2
    exit 1
  fi
  echo "plan-capture-smoke: cleanup complete (verified absent)."
else
  echo "plan-capture-smoke: --keep set; smoke doc ${expected_name} (id ${doc_id}) left in place."
  # ui-url.sh emits either "Dify UI: <url>" on success or a "not
  # published yet" warning. Parse only the success line so we don't
  # paste the warning text into our own "View at ..." message.
  if [ -x "$SCRIPT_DIR/ui-url.sh" ]; then
    ui_line="$("$SCRIPT_DIR/ui-url.sh" 2>/dev/null || true)"
    ui_url="$(printf '%s\n' "$ui_line" | sed -n 's/^Dify UI: \(http[^ ]*\)$/\1/p' | head -n 1)"
    if [ -n "$ui_url" ]; then
      echo "  View at ${ui_url} → Knowledge → plans dataset."
    fi
  fi
fi

echo "plan-capture-smoke: PASS"
