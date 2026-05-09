#!/usr/bin/env bash
set -euo pipefail

# Interactive wizard: bind named Dify datasets (daily, knowledge, plans,
# investigations, ...) into memory/.env and optionally absorb existing
# project documentation into a dataset. Re-runnable.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [ "${1-}" = "-h" ] || [ "${1-}" = "--help" ]; then
  cat <<EOF
Usage:
  ./memory/scripts/dify-setup.sh [--non-interactive --auto-create]

Slot model: every DIFY_DATASET_<NAME>_ID line in memory/.env declares
one slot. Defaults are daily, knowledge, plans, investigations,
self_improvement; add more by adding lines.

Without flags: walks through API key check, dataset binding for each
slot (offers auto-create, pick existing, skip), and offers an
absorb-on-existing-docs pass.

With --non-interactive: requires --auto-create. Auto-creates any
unbound slot present in memory/.env (or the five defaults if absent),
writes IDs back, and exits without absorb.
EOF
  exit 0
fi

# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"
load_memory_env

ENV_FILE="$MEMORY_ENV"
[ -f "$ENV_FILE" ] || { echo "memory/.env missing. Run ./memory/bootstrap.sh first." >&2; exit 1; }

CONTAINER_NAME="$(read_env_value MCP_CONTAINER_NAME "$ENV_FILE" 2>/dev/null || true)"
[ -n "$CONTAINER_NAME" ] || { echo "MCP_CONTAINER_NAME not in memory/.env." >&2; exit 1; }

DEFAULT_DATASETS=("daily" "knowledge" "plans" "investigations" "self_improvement")

# Remove a key entirely from $ENV_FILE.
unset_env_var() {
  local key="$1" tmp
  if grep -qE "^${key}=" "$ENV_FILE"; then
    tmp="$(mktemp)"
    awk -v key="$key" -F= '$1 != key { print }' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  fi
}

# Discover slot names from memory/.env: every DIFY_DATASET_<NAME>_ID line
# declares one slot. Returns lowercase slot names, one per line.
discover_slots_from_env() {
  awk -F= '
    /^DIFY_DATASET_.+_ID=/ {
      key = $1
      sub(/^DIFY_DATASET_/, "", key)
      sub(/_ID$/, "", key)
      print tolower(key)
    }
  ' "$ENV_FILE"
}

NON_INTERACTIVE=0
AUTO_CREATE=0
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --auto-create) AUTO_CREATE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ---------- helpers ----------
prompt() {
  local msg="$1" default="${2-}"
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    printf '%s' "$default"
    return 0
  fi
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$msg" "$default" >&2
  else
    printf '%s: ' "$msg" >&2
  fi
  local ans
  read -r ans
  printf '%s' "${ans:-$default}"
}

confirm() {
  local msg="$1" default="${2-y}"
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    [ "$AUTO_CREATE" -eq 1 ] && return 0 || return 1
  fi
  local hint="[Y/n]"
  [ "$default" = "n" ] && hint="[y/N]"
  printf '%s %s ' "$msg" "$hint" >&2
  local ans
  read -r ans
  ans="${ans:-$default}"
  case "$ans" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# Idempotent set/replace KEY=VALUE in $ENV_FILE
set_env_var() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # Replace existing line in-place (BSD/GNU sed compatible)
    local tmp
    tmp="$(mktemp)"
    awk -v key="$key" -v value="$value" -F= '
      $1 == key { print key "=" value; next }
      { print }
    ' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    if [ -s "$ENV_FILE" ] && [ "$(tail -c 1 "$ENV_FILE")" != "" ]; then
      printf '\n' >> "$ENV_FILE"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

slot_to_env_key() {
  local slot="$1"
  printf 'DIFY_DATASET_%s_ID' "$(printf '%s' "$slot" | tr '[:lower:]-' '[:upper:]_')"
}

cli() {
  docker exec -i "$CONTAINER_NAME" node src/memory-cli.js "$@"
}

restart_bridge() {
  ( cd "$MEMORY_DIR" && docker_compose up -d --no-build memory_mcp >/dev/null )
  # Wait for the bridge to be healthy enough to accept exec calls.
  local attempts=0
  while [ "$attempts" -lt 30 ]; do
    if docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
      if docker exec -i "$CONTAINER_NAME" node -e 'process.exit(0)' 2>/dev/null; then
        return 0
      fi
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  echo "FATAL: bridge restart did not become ready within 30s." >&2
  return 1
}

# ---------- preflight ----------
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
  echo "Container '$CONTAINER_NAME' not running. Start with ./memory/scripts/up.sh" >&2
  exit 1
fi

API_KEY="$(read_env_value DIFY_KNOWLEDGE_API_KEY "$ENV_FILE" 2>/dev/null || true)"

echo
echo "===  Dify memory setup  ==="
echo "  workspace:       $WORKSPACE_DIR"
echo "  container:       $CONTAINER_NAME"
echo "  api key set:     $([ -n "$API_KEY" ] && printf 'yes' || printf 'NO')"
echo

if [ -z "$API_KEY" ]; then
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    cat <<EOF >&2
FATAL: DIFY_KNOWLEDGE_API_KEY not set; cannot continue in --non-interactive mode.

Set it first, then re-run:
  1) Open the Dify UI ($("$SCRIPT_DIR/ui-url.sh" 2>/dev/null || echo '<run ./memory/scripts/ui-url.sh>')).
  2) Knowledge -> Service API -> create a Knowledge API key.
  3) Edit memory/.env: DIFY_KNOWLEDGE_API_KEY=<the-key>
  4) Restart the bridge: docker compose -p "\$COMPOSE_PROJECT_NAME" up -d --no-build memory_mcp
  5) ./memory/scripts/dify-setup.sh --non-interactive --auto-create
EOF
    exit 1
  fi
  echo "Open the Dify UI ($("$SCRIPT_DIR/ui-url.sh" 2>/dev/null || echo '<run ./memory/scripts/ui-url.sh>'))"
  echo "Knowledge -> Service API -> create a Knowledge API key. Paste it now."
  api_key="$(prompt 'DIFY_KNOWLEDGE_API_KEY' '')"
  [ -n "$api_key" ] || { echo 'aborted' >&2; exit 1; }
  set_env_var DIFY_KNOWLEDGE_API_KEY "$api_key"
  API_KEY="$api_key"
  echo "Restarting bridge with the new key..."
  restart_bridge || { echo "FATAL: cannot proceed without a healthy bridge." >&2; exit 1; }
fi

# ---------- discover existing datasets ----------
echo "Listing existing Dify datasets..."
list_json="$(cli list-datasets 2>/dev/null || true)"
if ! printf '%s' "$list_json" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' >/dev/null 2>&1; then
  echo "Could not list datasets via the bridge. Check DIFY_KNOWLEDGE_API_KEY." >&2
  exit 1
fi

# Migrate from the old DIFY_DATASETS list var, if present, by seeding
# DIFY_DATASET_<NAME>_ID lines for each name and removing the legacy var.
# Use existence (grep) not value emptiness so a `DIFY_DATASETS=` line with
# no value is also cleaned up.
if grep -qE '^DIFY_DATASETS=' "$ENV_FILE"; then
  legacy_list="$(read_env_value DIFY_DATASETS "$ENV_FILE" 2>/dev/null || true)"
  echo "Migrating legacy DIFY_DATASETS=${legacy_list:-<empty>} -> per-slot env lines."
  for migrated in $(echo "$legacy_list" | tr ',' '\n' | awk 'NF'); do
    migrated="$(echo "$migrated" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
    [ -n "$migrated" ] || continue
    migrated_key="$(slot_to_env_key "$migrated")"
    grep -qE "^${migrated_key}=" "$ENV_FILE" || set_env_var "$migrated_key" ""
  done
  unset_env_var DIFY_DATASETS
fi

# Slot list = whatever DIFY_DATASET_*_ID lines are in memory/.env, plus any
# default slot that isn't already declared. Preserves declaration order then
# appends defaults at the end.
declared_slots_arr=()
while IFS= read -r s; do
  [ -n "$s" ] || continue
  declared_slots_arr+=("$s")
done < <(discover_slots_from_env)
for d in "${DEFAULT_DATASETS[@]}"; do
  found=0
  # Bash 3.2 (default on macOS) treats expansion of an empty array under
  # `set -u` as unset; guard with a length check before iterating.
  if [ "${#declared_slots_arr[@]}" -gt 0 ]; then
    for existing in "${declared_slots_arr[@]}"; do
      [ "$existing" = "$d" ] && { found=1; break; }
    done
  fi
  if [ "$found" -eq 0 ]; then
    declared_slots_arr+=("$d")
    set_env_var "$(slot_to_env_key "$d")" ""
  fi
done
declared_slots="$(IFS=,; printf '%s' "${declared_slots_arr[*]}")"

echo "Slots to handle: $declared_slots"
echo

# ---------- bind each slot ----------
write_slots=""
for slot in $(echo "$declared_slots" | tr ',' '\n' | awk 'NF'); do
  slot="$(echo "$slot" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
  [ -n "$slot" ] || continue
  env_key="$(slot_to_env_key "$slot")"
  current_id="$(read_env_value "$env_key" "$ENV_FILE" 2>/dev/null || true)"

  echo "--- slot: $slot ($env_key) ---"
  if [ -n "$current_id" ]; then
    echo "  already bound to dataset id: $current_id"
    if confirm "  Re-bind?" n; then
      current_id=""
    fi
  fi

  if [ -z "$current_id" ]; then
    if [ "$NON_INTERACTIVE" -eq 1 ] || confirm "  Auto-create a Dify dataset named '$slot'?" y; then
      created_json="$(cli create-dataset --name "$slot" --description "Auto-created by dify-setup.sh for the '$slot' memory slot")"
      new_id="$(printf '%s' "$created_json" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((o.id||o.dataset?.id||""))')"
      if [ -n "$new_id" ]; then
        echo "  created dataset id: $new_id"
        set_env_var "$env_key" "$new_id"
        write_slots="$write_slots $slot"
      else
        echo "  WARNING: could not parse new dataset id from: $created_json" >&2
      fi
    elif [ "$NON_INTERACTIVE" -ne 1 ] && confirm "  Use an existing dataset id?" n; then
      existing_id="$(prompt '  Existing dataset id' '')"
      if [ -n "$existing_id" ]; then
        set_env_var "$env_key" "$existing_id"
        write_slots="$write_slots $slot"
      fi
    else
      echo "  skipped"
    fi
  else
    write_slots="$write_slots $slot"
  fi
  echo
done

# Restart bridge so env propagates (new IDs and any new slot lines).
echo "Restarting bridge to pick up dataset bindings..."
restart_bridge || { echo "FATAL: cannot proceed without a healthy bridge." >&2; exit 1; }

# ---------- install metadata schema on every BOUND slot ----------
# Boilerplate's filtered-retrieve and per-document metadata writes assume
# every slot has the six fields below. Idempotent: skipped if the field
# already exists on the dataset.
SCHEMA_FIELDS=(atom_type tags project_module language task_type error_pattern)

install_metadata_schema() {
  local slot="$1" dataset_id="$2"
  local fields_json
  # Pass the resolved UUID; the bridge's resolveDatasetId would also accept
  # the slot name, but the UUID makes failures unambiguous in logs.
  fields_json="$(cli list-metadata-fields --datasetId "$dataset_id" 2>/dev/null || true)"
  if ! printf '%s' "$fields_json" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' >/dev/null 2>&1; then
    echo "    WARNING: could not list metadata fields for '$slot' ($dataset_id); skipping schema install." >&2
    return 0
  fi
  for field in "${SCHEMA_FIELDS[@]}"; do
    has="$(printf '%s' "$fields_json" | node -e "
      const o = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const f = (o.doc_metadata || []).find((x) => x && x.name === '$field');
      process.stdout.write(f ? 'yes' : 'no');
    ")"
    if [ "$has" = "yes" ]; then
      echo "    field '$field' already present"
    else
      echo "    creating field '$field' (string)"
      cli create-metadata-field --datasetId "$dataset_id" --name "$field" --type string >/dev/null \
        || echo "    WARNING: failed to create field '$field' on '$slot'" >&2
    fi
  done
}

echo
echo "Installing metadata schema on bound slots..."
for slot in $(echo "$declared_slots" | tr ',' '\n' | awk 'NF'); do
  slot="$(echo "$slot" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
  env_key="$(slot_to_env_key "$slot")"
  current_id="$(read_env_value "$env_key" "$ENV_FILE" 2>/dev/null || true)"
  if [ -z "$current_id" ]; then
    echo "  slot: $slot — unbound, skipping schema install"
    continue
  fi
  echo "  slot: $slot ($current_id)"
  install_metadata_schema "$slot" "$current_id"
done

# Offer to enable Dify's built-in metadata fields (document_name,
# upload_date, last_update_date, etc.) so they are also filterable.
if [ "$NON_INTERACTIVE" -eq 1 ] || confirm "Enable Dify built-in metadata fields (document_name, upload_date, last_update_date) on bound slots?" y; then
  for slot in $(echo "$declared_slots" | tr ',' '\n' | awk 'NF'); do
    slot="$(echo "$slot" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
    env_key="$(slot_to_env_key "$slot")"
    current_id="$(read_env_value "$env_key" "$ENV_FILE" 2>/dev/null || true)"
    [ -n "$current_id" ] || continue
    cli set-built-in-metadata --datasetId "$current_id" --enabled true >/dev/null \
      || echo "  WARNING: failed to enable built-in metadata on '$slot'" >&2
  done
fi

# ---------- optional absorb ----------
if [ "$NON_INTERACTIVE" -eq 1 ]; then
  echo "Non-interactive: skipping absorb step."
else
  echo
  if confirm "Scan the workspace for documents to absorb into a dataset?" y; then
    # Default target slot: knowledge if bound, otherwise the first bound slot.
    knowledge_id="$(read_env_value DIFY_DATASET_KNOWLEDGE_ID "$ENV_FILE" 2>/dev/null || true)"
    if [ -n "$knowledge_id" ]; then
      default_target="knowledge"
    else
      default_target=""
      # Bash 3.2 + set -u: guard empty-array iteration.
      if [ "${#declared_slots_arr[@]}" -gt 0 ]; then
        for try_slot in "${declared_slots_arr[@]}"; do
          try_id="$(read_env_value "$(slot_to_env_key "$try_slot")" "$ENV_FILE" 2>/dev/null || true)"
          if [ -n "$try_id" ]; then default_target="$try_slot"; break; fi
        done
      fi
      [ -n "$default_target" ] || { echo "No bound slot to absorb into. Bind a slot first." >&2; default_target="knowledge"; }
    fi
    target_slot="$(prompt 'Target slot for absorbed docs' "$default_target")"
    include_globs="$(prompt 'Include globs (comma-separated)' '**/*.md,**/*.mdx,**/*.markdown,**/*.txt,**/*.rst,**/*.adoc')"
    scan_json="$(cli scan --include "$include_globs")"
    total="$(printf '%s' "$scan_json" | node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(o.total||0))')"
    if [ "$total" = "0" ]; then
      echo "No matches found."
    else
      echo "Found $total file(s):"
      printf '%s' "$scan_json" | node -e '
        const o = JSON.parse(require("fs").readFileSync(0,"utf8"));
        for (const f of o.files) console.log("  " + f.relPath + "  -> " + f.docName + "  (" + f.size + "B)");
      '
      echo
      echo "Selection: empty=all, 'none' to skip, or a comma-separated list of relPath strings."
      selection="$(prompt 'Files to absorb' '')"
      if [ "$selection" = "none" ]; then
        echo "Absorb skipped."
      else
        if [ -z "$selection" ]; then
          selection="$(printf '%s' "$scan_json" | node -e '
            const o = JSON.parse(require("fs").readFileSync(0,"utf8"));
            process.stdout.write(o.files.map((f) => f.relPath).join(","));
          ')"
        fi
        echo "Absorbing into slot '$target_slot' (dry run first)..."
        cli absorb --datasetId "$target_slot" --files "$selection" --dryRun "true"
        if confirm "Looks right?" y; then
          cli absorb --datasetId "$target_slot" --files "$selection"
          echo "Done."
        else
          echo "Absorb cancelled."
        fi
      fi
    fi
  fi
fi

echo
echo "Setup complete. Summary:"
for slot in $(echo "$declared_slots" | tr ',' '\n' | awk 'NF'); do
  slot="$(echo "$slot" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
  env_key="$(slot_to_env_key "$slot")"
  current_id="$(read_env_value "$env_key" "$ENV_FILE" 2>/dev/null || true)"
  printf '  %-20s %s\n' "$slot" "${current_id:-<unbound>}"
done
echo
echo "memory/.env updated. Re-run any time to add slots or re-absorb."
