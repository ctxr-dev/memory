#!/usr/bin/env bash
set -euo pipefail

# Renders project-root files (.agents/, .claude/settings.json, .gitignore block,
# memory/.env) from templates inside the cloned boilerplate. Idempotent: safe to
# re-run after `cd memory && git pull`. Never overwrites memory/.env.

MEMORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORKSPACE_DIR="$(cd "$MEMORY_DIR/.." && pwd -P)"
TEMPLATES_DIR="$MEMORY_DIR/templates"

usage() {
  cat <<'USAGE'
Usage:
  ./memory/bootstrap.sh --slug <project-slug> [options]

Options:
  --slug <slug>            Required. Lowercase ASCII a-z, 0-9, -.
  --title "<title>"        Display title (default: title-cased slug).
  --llm-provider <p>       claude | codex | anthropic | openai | ask (default: ask)
  --install-hooks          Install Claude Code hooks (default: on).
  --no-hooks               Skip Claude Code hook install.
  --register-codex         If codex CLI present, register the MCP server.
  --no-interactive         Fail if a value would have been prompted for.
  -h, --help               This help.

Run from the user-project root after `git clone <boilerplate> ./memory`.
USAGE
}

slug=""
title=""
llm_provider="ask"
install_hooks=1
register_codex=0
interactive=1

require_value() {
  local opt="$1" val="${2-}"
  if [ -z "$val" ] || [ "${val:0:2}" = "--" ]; then
    echo "$opt requires a value." >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --slug) require_value "$1" "${2-}"; slug="$2"; shift 2 ;;
    --title) require_value "$1" "${2-}"; title="$2"; shift 2 ;;
    --llm-provider) require_value "$1" "${2-}"; llm_provider="$2"; shift 2 ;;
    --install-hooks) install_hooks=1; shift ;;
    --no-hooks) install_hooks=0; shift ;;
    --register-codex) register_codex=1; shift ;;
    --no-interactive) interactive=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ---------- prereq checks ----------
require_cmd() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing prerequisite: $cmd ($hint)" >&2
    exit 1
  fi
}

require_cmd docker "install Docker Desktop or docker engine"
require_cmd node "install Node.js 20+"

compose_version="$(docker compose version --short 2>/dev/null || true)"
if [ -z "$compose_version" ]; then
  echo "docker compose not available. Install Docker Compose 2.24.4+." >&2
  exit 1
fi
required_compose="2.24.4"
lowest="$(printf '%s\n%s\n' "$compose_version" "$required_compose" | sort -V | head -n1)"
if [ "$lowest" != "$required_compose" ] && [ "$compose_version" != "$required_compose" ]; then
  echo "docker compose $compose_version is too old; need $required_compose+." >&2
  exit 1
fi

node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 20 ]; then
  echo "node $node_major is too old; need 20+." >&2
  exit 1
fi

# ---------- slug ----------
sanitize_slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-//; s/-$//'
}

if [ -z "$slug" ]; then
  derived="$(sanitize_slug "$(basename "$WORKSPACE_DIR")")"
  if [ "$interactive" -eq 1 ] && [ -t 0 ]; then
    printf 'Project slug [%s]: ' "$derived"
    read -r answer
    slug="${answer:-$derived}"
  else
    slug="$derived"
  fi
fi
slug="$(sanitize_slug "$slug")"
if [ -z "$slug" ] || ! printf '%s' "$slug" | grep -qE '^[a-z0-9][a-z0-9-]*[a-z0-9]$'; then
  echo "Invalid slug: '$slug'. Use lowercase a-z, 0-9, -." >&2
  exit 1
fi

if [ -z "$title" ]; then
  title="$(printf '%s' "$slug" | tr '_-' '  ' \
    | awk '{for(i=1;i<=NF;i++)$i=toupper(substr($i,1,1)) substr($i,2);print}')"
fi

memory_server_name="${slug}-memory"
compose_project_name="${slug}-memory-stack"
mcp_image_name="${slug}-memory-mcp:local"

# ---------- LLM provider ----------
detect_provider_available() {
  case "$1" in
    claude) command -v claude >/dev/null 2>&1 ;;
    codex)  command -v codex >/dev/null 2>&1 ;;
    anthropic) [ -n "${ANTHROPIC_API_KEY:-}" ] ;;
    openai) [ -n "${OPENAI_API_KEY:-}" ] ;;
    *) return 1 ;;
  esac
}

if [ "$llm_provider" = "ask" ]; then
  available=()
  for p in claude codex anthropic openai; do
    if detect_provider_available "$p"; then available+=("$p"); fi
  done
  if [ "${#available[@]}" -eq 0 ]; then
    echo "Note: no LLM provider detected (no claude/codex CLI on PATH; no API keys in env)." >&2
    echo "      Defaulting to MEMORY_LLM_PROVIDER=claude. Edit memory/.env to change." >&2
    llm_provider="claude"
  elif [ "${#available[@]}" -eq 1 ]; then
    llm_provider="${available[0]}"
    echo "Auto-selected MEMORY_LLM_PROVIDER=$llm_provider (only available provider)."
  elif [ "$interactive" -eq 1 ] && [ -t 0 ]; then
    echo "Detected LLM providers:"
    i=1
    for p in "${available[@]}"; do echo "  $i) $p"; i=$((i+1)); done
    printf 'Choose provider for memory distillation [1]: '
    read -r choice
    choice="${choice:-1}"
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#available[@]}" ]; then
      echo "Invalid choice." >&2; exit 1
    fi
    llm_provider="${available[$((choice-1))]}"
  else
    llm_provider="${available[0]}"
    echo "Auto-selected first available provider: $llm_provider (use --llm-provider to override)."
  fi
fi

case "$llm_provider" in
  claude|codex|anthropic|openai) : ;;
  *) echo "Invalid --llm-provider '$llm_provider'." >&2; exit 1 ;;
esac

# ---------- template render ----------
escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

render() {
  local src="$1"
  sed \
    -e "s|__PROJECT_SLUG__|$(escape_sed_replacement "$slug")|g" \
    -e "s|__PROJECT_TITLE__|$(escape_sed_replacement "$title")|g" \
    -e "s|__MEMORY_SERVER_NAME__|$(escape_sed_replacement "$memory_server_name")|g" \
    -e "s|__COMPOSE_PROJECT_NAME__|$(escape_sed_replacement "$compose_project_name")|g" \
    -e "s|__MCP_IMAGE_NAME__|$(escape_sed_replacement "$mcp_image_name")|g" \
    "$src"
}

placeholder_mcp_basename="__MEMORY_SERVER_NAME__.mcp.json"

target_rel_for_agents() {
  local rel="$1"
  if [ "$(basename "$rel")" = "$placeholder_mcp_basename" ] && [ "$(dirname "$rel")" = "mcp" ]; then
    printf 'mcp/%s.mcp.json' "$memory_server_name"
  else
    printf '%s' "$rel"
  fi
}

# Render templates/agents/* -> $WORKSPACE_DIR/.agents/
agents_src="$TEMPLATES_DIR/agents"
agents_dst="$WORKSPACE_DIR/.agents"
conflicts="$(mktemp)"
trap 'rm -f "$conflicts"' EXIT

while IFS= read -r -d '' file; do
  rel="${file#$agents_src/}"
  case "$rel" in
    hooks.json)
      [ "$install_hooks" -eq 1 ] || continue ;;
  esac
  dst_rel="$(target_rel_for_agents "$rel")"
  dst="$agents_dst/$dst_rel"
  if [ -f "$dst" ]; then
    rendered="$(mktemp)"
    render "$file" > "$rendered"
    cmp -s "$rendered" "$dst" || printf '.agents/%s\n' "$dst_rel" >> "$conflicts"
    rm -f "$rendered"
  fi
done < <(find "$agents_src" -type f ! -name '.DS_Store' -print0)

# Render templates/claude/settings.json -> $WORKSPACE_DIR/.claude/settings.json (if hooks)
if [ "$install_hooks" -eq 1 ]; then
  claude_dst="$WORKSPACE_DIR/.claude/settings.json"
  if [ -f "$claude_dst" ]; then
    rendered="$(mktemp)"
    render "$TEMPLATES_DIR/claude/settings.json" > "$rendered"
    cmp -s "$rendered" "$claude_dst" || echo ".claude/settings.json" >> "$conflicts"
    rm -f "$rendered"
  fi
fi

if [ -s "$conflicts" ]; then
  echo "Refusing to overwrite differing files:" >&2
  sed 's/^/  - /' "$conflicts" >&2
  echo "Move/merge these files manually then re-run bootstrap.sh." >&2
  exit 1
fi

# Write agents files (skip if identical)
mkdir -p "$agents_dst"
while IFS= read -r -d '' file; do
  rel="${file#$agents_src/}"
  case "$rel" in
    hooks.json) [ "$install_hooks" -eq 1 ] || continue ;;
  esac
  dst_rel="$(target_rel_for_agents "$rel")"
  dst="$agents_dst/$dst_rel"
  mkdir -p "$(dirname "$dst")"
  if [ ! -f "$dst" ]; then
    render "$file" > "$dst"
  fi
done < <(find "$agents_src" -type f ! -name '.DS_Store' -print0)

if [ "$install_hooks" -eq 1 ]; then
  mkdir -p "$WORKSPACE_DIR/.claude"
  if [ ! -f "$WORKSPACE_DIR/.claude/settings.json" ]; then
    render "$TEMPLATES_DIR/claude/settings.json" > "$WORKSPACE_DIR/.claude/settings.json"
  fi
fi

# ---------- gitignore append (idempotent via marker) ----------
gitignore="$WORKSPACE_DIR/.gitignore"
marker="# Local Dify MCP memory boilerplate"
touch "$gitignore"
if ! grep -qxF "$marker" "$gitignore"; then
  if [ -s "$gitignore" ] && [ "$(tail -c 1 "$gitignore")" != "" ]; then
    printf '\n' >> "$gitignore"
  fi
  printf '\n' >> "$gitignore"
  cat "$TEMPLATES_DIR/gitignore.append" >> "$gitignore"
fi

# ---------- memory/.env (only if missing) ----------
env_file="$MEMORY_DIR/.env"
if [ ! -f "$env_file" ]; then
  cp "$MEMORY_DIR/.env.example" "$env_file"
  {
    printf '\n'
    printf '# Auto-injected by bootstrap.sh\n'
    printf 'MEMORY_SLUG=%s\n' "$slug"
    printf 'MEMORY_LLM_PROVIDER=%s\n' "$llm_provider"
    printf 'MCP_CONTAINER_NAME=%s\n' "$memory_server_name"
    printf 'COMPOSE_PROJECT_NAME=%s\n' "$compose_project_name"
    printf 'MCP_IMAGE_NAME=%s\n' "$mcp_image_name"
  } >> "$env_file"
  env_action="created"
else
  env_action="left untouched"
fi

# ---------- ensure host data dir placeholder ----------
mkdir -p "$WORKSPACE_DIR/.memory/dify"
[ -f "$WORKSPACE_DIR/.memory/dify/.keep" ] || : > "$WORKSPACE_DIR/.memory/dify/.keep"

# ---------- chmod ----------
chmod +x "$MEMORY_DIR"/scripts/*.sh "$MEMORY_DIR"/scripts/hooks/*.sh 2>/dev/null || true
chmod +x "$MEMORY_DIR"/bootstrap.sh 2>/dev/null || true

# ---------- optional codex registration ----------
if [ "$register_codex" -eq 1 ]; then
  if command -v codex >/dev/null 2>&1; then
    if codex mcp get "$memory_server_name" >/dev/null 2>&1; then
      echo "Codex MCP server already registered: $memory_server_name"
    else
      codex mcp add "$memory_server_name" -- docker exec -i "$memory_server_name" node src/index.js
    fi
  else
    echo "codex CLI not found; skipping --register-codex." >&2
  fi
fi

# ---------- summary ----------
cat <<EOF

Bootstrap complete.

  Workspace:           $WORKSPACE_DIR
  Project slug:        $slug
  Memory MCP server:   $memory_server_name
  LLM provider:        $llm_provider
  Hooks installed:     $([ "$install_hooks" -eq 1 ] && printf 'yes' || printf 'no')
  memory/.env:         $env_action

Next steps:
  1) ./memory/scripts/up.sh                     # start the Dify stack
  2) ./memory/scripts/ui-url.sh                 # open the printed URL
  3) In Dify UI: create the admin account, configure an embedding model,
     then Knowledge -> Service API -> create a Knowledge API key.
  4) ./memory/scripts/dify-setup.sh              # paste API key, bind/auto-create
                                                  the four dataset slots (daily,
                                                  knowledge, plans, investigations),
                                                  optionally absorb existing docs.
  5) ./memory/scripts/mcp-smoke.sh               # validate

The boilerplate ships with its own .git so you can update it later:
  cd memory && git pull && cd .. && ./memory/bootstrap.sh --slug $slug

Re-running bootstrap is idempotent. memory/.env is preserved across upgrades.
EOF
