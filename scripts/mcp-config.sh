#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

load_memory_env
container_name="${MCP_CONTAINER_NAME:-$(read_env_value MCP_CONTAINER_NAME "$MEMORY_ENV" 2>/dev/null || true)}"
if [ -z "$container_name" ] || [ "$container_name" = "__MEMORY_SERVER_NAME__" ]; then
  echo "FATAL: MCP_CONTAINER_NAME not set in $MEMORY_ENV (got '$container_name')." >&2
  echo "  Run bootstrap.sh --slug <project-slug> first." >&2
  exit 1
fi

print_json() {
  cat <<EOF
{
  "mcpServers": {
    "$container_name": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "$container_name",
        "node",
        "src/index.js"
      ]
    }
  }
}
EOF
}

print_codex_toml() {
  cat <<EOF
[mcp_servers.$container_name]
command = "docker"
args = ["exec", "-i", "$container_name", "node", "src/index.js"]
EOF
}

print_codex_command() {
  printf 'codex mcp add %s -- docker exec -i %s node src/index.js\n' "$container_name" "$container_name"
}

usage() {
  cat <<'EOF'
Usage:
  mcp-config.sh json
  mcp-config.sh claude-desktop
  mcp-config.sh cursor
  mcp-config.sh codex
  mcp-config.sh codex-toml
  mcp-config.sh all
EOF
}

case "${1:-all}" in
  json|generic|claude-desktop|cursor)
    print_json
    ;;
  codex)
    print_codex_command
    ;;
  codex-toml)
    print_codex_toml
    ;;
  all)
    printf '# Generic / Claude Desktop / Cursor JSON\n'
    print_json
    printf '\n# Codex/OpenAI command\n'
    print_codex_command
    printf '\n# Codex/OpenAI TOML\n'
    print_codex_toml
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown client config target: $1" >&2
    usage >&2
    exit 1
    ;;
esac
