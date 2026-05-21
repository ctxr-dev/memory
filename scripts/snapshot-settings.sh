#!/usr/bin/env bash
# Best-effort: NEVER abort the caller. We deliberately do NOT use `set -e`
# so a failing copy / mkdir / heredoc (permissions, full disk) prints a
# warning and the script still reaches `exit 0`. Keep nounset + pipefail
# for sane variable + pipe behavior.
set -uo pipefail

# Snapshot user settings (memory/.env, memory/.dify-version, and a
# best-effort embedding-model record) into <MEMORY_DATA_DIR>/settings/ so
# they survive removing/re-cloning ./memory. The Dify data already lives
# under ./.memory/; this co-locates the user's config with it. Restored
# automatically on the next bootstrap.sh.
#
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

# Resolve the settings dir directly (tolerate partial state).
data_dir="${MEMORY_DATA_DIR:-$(read_env_value MEMORY_DATA_DIR "$MEMORY_ENV" 2>/dev/null || true)}"
data_dir="${data_dir:-$WORKSPACE_DIR/.memory}"
settings_dir="$data_dir/settings"

# Create + verify the settings dir is writable. If we can't write it
# (permissions, full disk, read-only mount), warn to stderr and exit 0
# WITHOUT claiming a snapshot happened: best-effort, never fatal.
mkdir -p "$settings_dir" 2>/dev/null || true
if [ ! -d "$settings_dir" ] || [ ! -w "$settings_dir" ]; then
  echo "warning: settings dir '$settings_dir' is not writable; skipped snapshot." >&2
  exit 0
fi

snapped=()

# --- .env (carries the API key; least-privilege perms) ---
# Gate the summary entry on the copy actually succeeding so we never
# claim a file was captured when the write failed.
if [ -f "$MEMORY_DIR/.env" ]; then
  if cp "$MEMORY_DIR/.env" "$settings_dir/.env" 2>/dev/null; then
    # The copy carries the Dify API key. Warn (don't fail) if we can't
    # tighten perms so the user knows the snapshot may be readable.
    chmod 600 "$settings_dir/.env" 2>/dev/null || \
      echo "warning: could not chmod 600 $settings_dir/.env; it carries the API key and may be readable by others." >&2
    snapped+=(".env")
  else
    echo "warning: could not copy .env into the snapshot." >&2
  fi
fi

# --- .dify-version ---
if [ -f "$MEMORY_DIR/.dify-version" ]; then
  if cp "$MEMORY_DIR/.dify-version" "$settings_dir/.dify-version" 2>/dev/null; then
    snapped+=(".dify-version")
  else
    echo "warning: could not copy .dify-version into the snapshot." >&2
  fi
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

# Gate the summary entry on the redirect actually succeeding (parity with
# the .env/.dify-version copies) so a failed write (disk full / transient
# FS error after the -w check) is never reported as captured.
if [ -n "$embed_model" ]; then
  embed_body="$embed_model"
  embed_label="embedding-model.txt ($embed_model)"
else
  embed_body="(embedding model unknown; bridge not reachable at snapshot time)"
  embed_label="embedding-model.txt (unknown)"
fi
if { printf '# recorded %s\n' "${ts:-unknown}"; printf '%s\n' "$embed_body"; } > "$settings_dir/embedding-model.txt" 2>/dev/null; then
  snapped+=("$embed_label")
else
  echo "warning: could not write embedding-model.txt into the snapshot." >&2
fi

# --- README ---
# Gate the heredoc write so a failure (disk full / transient FS error after
# the -w check) emits a warning, matching the header comment and the parity
# of the .env / .dify-version / embedding-model.txt writes above.
if ! cat > "$settings_dir/README.txt" <<'EOF'
This directory is an automatic snapshot of your memory boilerplate user
settings (memory/.env with the API key + dataset bindings, the pinned
Dify version, and the configured embedding model). It lives alongside the
persistent Dify data so it is SAFE TO KEEP when you remove or re-clone
./memory. On the next ./memory/bootstrap.sh these settings are restored
automatically (the .env is copied back, so re-running dify-setup.sh is
optional). Re-created on every successful setup/up run.
EOF
then
  echo "warning: could not write README.txt into the snapshot." >&2
else
  snapped+=("README.txt")
fi

# Only claim a snapshot when something was actually captured.
if [ "${#snapped[@]}" -gt 0 ]; then
  echo "Settings snapshot written to: $settings_dir"
  for item in "${snapped[@]}"; do
    echo "  - $item"
  done
else
  echo "warning: nothing captured into $settings_dir (no memory/.env and all writes failed)." >&2
fi

exit 0
