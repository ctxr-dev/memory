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

# Resolve the settings dir directly (tolerate partial state).
data_dir="${MEMORY_DATA_DIR:-$(read_env_value MEMORY_DATA_DIR "$MEMORY_ENV" 2>/dev/null || true)}"
data_dir="${data_dir:-$WORKSPACE_DIR/.memory}"
settings_dir="$data_dir/settings"

mkdir -p "$settings_dir"

snapped=()

# --- .env (carries the API key; least-privilege perms) ---
if [ -f "$MEMORY_DIR/.env" ]; then
  cp "$MEMORY_DIR/.env" "$settings_dir/.env"
  chmod 600 "$settings_dir/.env" 2>/dev/null || true
  snapped+=(".env")
fi

# --- .dify-version ---
if [ -f "$MEMORY_DIR/.dify-version" ]; then
  cp "$MEMORY_DIR/.dify-version" "$settings_dir/.dify-version"
  snapped+=(".dify-version")
fi

# --- best-effort embedding-model record ---
ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || true)"
container="${MCP_CONTAINER_NAME:-$(read_env_value MCP_CONTAINER_NAME "$MEMORY_ENV" 2>/dev/null || true)}"
embed_model=""
if [ -n "$container" ] && command -v docker >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  # `node` (host) is used to parse the JSON below; guard it so a missing
  # node doesn't leak "command not found" even in this best-effort path.
  embed_json="$(docker exec -i "$container" node src/memory-cli.js list-embedding-models 2>/dev/null || true)"
  if [ -n "$embed_json" ]; then
    embed_model="$(printf '%s' "$embed_json" | node -e '
      try {
        const o = JSON.parse(require("fs").readFileSync(0, "utf8"));
        const out = [];
        const providers = o && Array.isArray(o.providers) ? o.providers : [];
        for (const p of providers) {
          const prov = p && (p.provider || p.name) ? (p.provider || p.name) : "";
          const models = p && Array.isArray(p.models) ? p.models : [];
          if (models.length) {
            for (const m of models) {
              const id = m && (m.model || m.name || m.id) ? (m.model || m.name || m.id) : "";
              if (id) out.push(prov ? prov + "/" + id : id);
            }
          } else if (prov) {
            out.push(prov);
          }
        }
        if (!out.length && o && (o.model || o.provider)) {
          out.push((o.provider ? o.provider + "/" : "") + (o.model || ""));
        }
        process.stdout.write(out.join(", "));
      } catch { process.stdout.write(""); }
    ' 2>/dev/null || true)"
  fi
fi

if [ -n "$embed_model" ]; then
  {
    printf '# recorded %s\n' "${ts:-unknown}"
    printf '%s\n' "$embed_model"
  } > "$settings_dir/embedding-model.txt"
  snapped+=("embedding-model.txt ($embed_model)")
else
  {
    printf '# recorded %s\n' "${ts:-unknown}"
    printf '(embedding model unknown — bridge not reachable at snapshot time)\n'
  } > "$settings_dir/embedding-model.txt"
  snapped+=("embedding-model.txt (unknown)")
fi

# --- README ---
cat > "$settings_dir/README.txt" <<'EOF'
This directory is an automatic snapshot of your memory boilerplate user
settings (memory/.env with the API key + dataset bindings, the pinned
Dify version, and the configured embedding model). It lives alongside the
persistent Dify data so it is SAFE TO KEEP when you remove or re-clone
./memory. On the next ./memory/bootstrap.sh these settings are restored
automatically (the .env is copied back, so re-running dify-setup.sh is
optional). Re-created on every successful setup/up run.
EOF

echo "Settings snapshot written to: $settings_dir"
if [ "${#snapped[@]}" -gt 0 ]; then
  for item in "${snapped[@]}"; do
    echo "  - $item"
  done
fi

exit 0
