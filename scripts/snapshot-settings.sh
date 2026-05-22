#!/usr/bin/env bash
# Best-effort: NEVER abort the caller. We deliberately do NOT use `set -e`
# so a failing mkdir / chmod / heredoc (permissions, full disk) prints a
# warning and the script still reaches `exit 0`. Keep nounset + pipefail
# for sane variable + pipe behavior.
set -uo pipefail

# Refresh the generated records under <MEMORY_DATA_DIR>/settings/ and tighten
# the canonical .env perms. As of v0.3.0 the .env and .dify-version ARE
# canonical in settings/ (not snapshots), so there is nothing to copy here;
# this script only:
#   - tightens settings/.env to 600 (it carries the Dify API key),
#   - records the single effective embedding model (informational),
#   - (re)writes a README.txt explaining the dir.
# Best-effort: NEVER fail the caller. Bash 3.2 portable, set -u safe.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Source lib.sh ONLY for read_env_value + path resolution
# (MEMORY_DIR/WORKSPACE_DIR/MEMORY_ENV). lib.sh's load_memory_env FATALs
# without COMPOSE_PROJECT_NAME, so we deliberately do NOT call it.
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"
# lib.sh runs `set -euo pipefail`; sourcing it RE-ENABLES errexit in this
# shell. Disable it again so this best-effort script never aborts the
# caller and always reaches `exit 0`.
set +e

# Resolve the settings dir directly (tolerate partial state). MEMORY_ENV is
# already <data_dir>/settings/.env (see lib.sh); the settings dir is its parent.
data_dir="${MEMORY_DATA_DIR:-$WORKSPACE_DIR/.memory}"
settings_dir="$data_dir/settings"

# Create + verify the settings dir is writable. If we can't write it
# (permissions, full disk, read-only mount), warn to stderr and exit 0.
mkdir -p "$settings_dir" 2>/dev/null || true
if [ ! -d "$settings_dir" ] || [ ! -w "$settings_dir" ]; then
  echo "warning: settings dir '$settings_dir' is not writable; skipped." >&2
  exit 0
fi

wrote=()

# --- tighten canonical .env perms (it carries the API key) ---
if [ -f "$settings_dir/.env" ]; then
  chmod 600 "$settings_dir/.env" 2>/dev/null || \
    echo "warning: could not chmod 600 $settings_dir/.env; it carries the API key and may be readable by others." >&2
fi

# --- best-effort embedding-model record ---
# Record the SINGLE effective embedding model the bridge actually uses (the
# Dify tenant's System Default), not the full list of available models: the
# whole point of the record is to tell a re-clone the ONE model to keep set
# as the System Default so the restored vector data stays consistent. The
# bridge resolves this via `get-embedding-default` (provider + model + source).
ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)"
container="${MCP_CONTAINER_NAME:-$(read_env_value MCP_CONTAINER_NAME "$MEMORY_ENV" 2>/dev/null || true)}"
embed_model=""
if [ -n "$container" ] && command -v docker >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  # `node` (host) is used to parse the JSON below; guard it so a missing
  # node doesn't leak "command not found" even in this best-effort path.
  embed_json="$(docker exec -i "$container" node src/memory-cli.js get-embedding-default 2>/dev/null || true)"
  if [ -n "$embed_json" ]; then
    embed_model="$(printf '%s' "$embed_json" | node -e '
      try {
        const o = JSON.parse(require("fs").readFileSync(0, "utf8"));
        // Only treat a real tenant default as known; tenant_empty /
        // probe_failed leave embed_model empty so the record says "unknown".
        const model = typeof o.model === "string" ? o.model : "";
        const prov = typeof o.provider === "string" ? o.provider : "";
        if (model) process.stdout.write(prov ? prov + "/" + model : model);
        else process.stdout.write("");
      } catch { process.stdout.write(""); }
    ' 2>/dev/null || true)"
  fi
fi

# Gate the summary entry on the redirect actually succeeding so a failed write
# (disk full / transient FS error after the -w check) is never reported.
if [ -n "$embed_model" ]; then
  embed_body="$embed_model"
  embed_label="embedding-model.txt ($embed_model)"
else
  embed_body="(embedding model unknown; bridge not reachable at this time)"
  embed_label="embedding-model.txt (unknown)"
fi
if { printf '# recorded %s\n' "${ts:-unknown}"; printf '%s\n' "$embed_body"; } > "$settings_dir/embedding-model.txt" 2>/dev/null; then
  wrote+=("$embed_label")
else
  echo "warning: could not write embedding-model.txt." >&2
fi

# --- README ---
if ! cat > "$settings_dir/README.txt" <<'EOF'
This directory holds your CANONICAL memory boilerplate settings (NOT a
snapshot): .env (Dify API key + dataset-slot bindings + env knobs),
.dify-version (the pinned Dify release), and embedding-model.txt (the single
effective embedding model, informational). It lives alongside the persistent
Dify data and is SAFE TO KEEP when you remove or re-clone the boilerplate. Edit .env
here (or run dify-setup.sh); the boilerplate's .env.example is only a
template. Re-created on every successful setup/up run.
EOF
then
  echo "warning: could not write README.txt." >&2
else
  wrote+=("README.txt")
fi

if [ "${#wrote[@]}" -gt 0 ]; then
  echo "Settings metadata refreshed in: $settings_dir"
  for item in "${wrote[@]}"; do
    echo "  - $item"
  done
fi

exit 0
