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
raw_input_slug="$slug"
slug="$(sanitize_slug "$slug")"
# Accept single-char slugs ("a") and multi-segment ("foo-bar"); reject
# consecutive dashes ("a--b") and leading/trailing dashes (after sanitize).
if [ -z "$slug" ] || ! printf '%s' "$slug" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$'; then
  if [ "$raw_input_slug" != "$slug" ]; then
    echo "Invalid slug: input '$raw_input_slug' sanitised to '$slug', which is not a valid slug." >&2
  else
    echo "Invalid slug: '$slug'." >&2
  fi
  echo "Slugs must contain only lowercase a-z, digits 0-9, and single dashes between segments. Examples: a, ab, foo-bar, billing-api." >&2
  exit 1
fi
# Note: sanitize_slug above silently rewrites uppercase to lowercase and
# non-alnum to dashes, so inputs like "Foo Bar", "foo_bar", or "ABC" all
# pass after rewrite. If you need strict input-validation, pass --slug
# explicitly and ensure it already matches the regex.

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

# ---------- merge strategy registry ----------
# Some destination files are MIXED: they hold both user content (their
# own MCP servers, their own hooks, their own permissions) AND our
# additions. For those we do a structural merge via Node helper
# `scripts/merge-config.mjs` (no jq dependency — Node is already a hard
# project requirement and works on every OS we support, including
# Windows + WSL/Git Bash). Re-runs of bootstrap update only the entries
# we own; user entries pass through verbatim.
#
# The rest of the agents/ tree (the per-server `.mcp.json` snippet, the
# `clients/*` snippets, README.md) is entirely generated by us — no user
# content possible — so the cmp-or-refuse path stays for them.
#
# Each line below is `<relative-path>:<strategy>`. Entries are matched
# against the path under .agents/ (or under the workspace root for
# `.claude/...`).
merge_strategy_for() {
  local rel="$1"
  case "$rel" in
    .agents/mcp.json)            printf 'mcp' ;;
    .agents/hooks.json)          printf 'hooks' ;;
    .claude/settings.json)       printf 'hooks' ;;
    *)                           printf '' ;;
  esac
}

# Run the structural-merge CLI: render template into a tmp, then merge
# tmp into dst preserving user content. Returns 0 on success; aborts
# bootstrap on any IO/parse failure (the merge tool surfaces a clear
# stderr message).
do_merge_install() {
  local template="$1"   # absolute path to source template
  local dst="$2"        # absolute path to destination
  local strategy="$3"   # 'hooks' or 'mcp'

  local rendered
  rendered="$(mktemp)"
  render "$template" > "$rendered"
  mkdir -p "$(dirname "$dst")"
  node "$MEMORY_DIR/scripts/merge-config.mjs" \
    --strategy="$strategy" \
    --target="$dst" \
    --source="$rendered" \
    >/dev/null
  local rc=$?
  rm -f "$rendered"
  if [ "$rc" -ne 0 ]; then
    echo "FATAL: merge-config failed for $dst (strategy=$strategy)." >&2
    exit "$rc"
  fi
}

# Render templates/agents/* -> $WORKSPACE_DIR/.agents/
agents_src="$TEMPLATES_DIR/agents"
agents_dst="$WORKSPACE_DIR/.agents"
conflicts="$(mktemp)"
trap 'rm -f "$conflicts"' EXIT

# Phase 1: detect conflicts on files that are NOT structurally mergeable.
# Mergeable files are skipped here — their conflict story is "merge
# in-place", which never refuses.
while IFS= read -r -d '' file; do
  rel="${file#$agents_src/}"
  case "$rel" in
    hooks.json)
      [ "$install_hooks" -eq 1 ] || continue ;;
  esac
  dst_rel="$(target_rel_for_agents "$rel")"
  dst_check_path=".agents/$dst_rel"
  strategy="$(merge_strategy_for "$dst_check_path")"
  [ -n "$strategy" ] && continue   # mergeable: handled in phase 2
  dst="$agents_dst/$dst_rel"
  if [ -f "$dst" ]; then
    rendered="$(mktemp)"
    render "$file" > "$rendered"
    cmp -s "$rendered" "$dst" || printf '%s\n' "$dst_check_path" >> "$conflicts"
    rm -f "$rendered"
  fi
done < <(find "$agents_src" -type f ! -name '.DS_Store' -print0)

if [ -s "$conflicts" ]; then
  echo "Refusing to overwrite differing files:" >&2
  sed 's/^/  - /' "$conflicts" >&2
  echo "These files are entirely owned by the boilerplate (snippets, README)." >&2
  echo "Move or remove them manually, then re-run bootstrap.sh." >&2
  echo "(Mixed-content files like .claude/settings.json, .agents/hooks.json" >&2
  echo " and .agents/mcp.json are auto-merged and never trigger this refusal.)" >&2
  exit 1
fi

# Phase 2: write owned-only files (skip if identical) and merge mixed
# files structurally.
mkdir -p "$agents_dst"
while IFS= read -r -d '' file; do
  rel="${file#$agents_src/}"
  case "$rel" in
    hooks.json) [ "$install_hooks" -eq 1 ] || continue ;;
  esac
  dst_rel="$(target_rel_for_agents "$rel")"
  dst="$agents_dst/$dst_rel"
  dst_check_path=".agents/$dst_rel"
  strategy="$(merge_strategy_for "$dst_check_path")"
  if [ -n "$strategy" ]; then
    do_merge_install "$file" "$dst" "$strategy"
    continue
  fi
  mkdir -p "$(dirname "$dst")"
  if [ ! -f "$dst" ]; then
    render "$file" > "$dst"
  fi
done < <(find "$agents_src" -type f ! -name '.DS_Store' -print0)

# Render templates/claude/settings.json -> $WORKSPACE_DIR/.claude/settings.json (if hooks).
# Always merge: even on first install we feed an empty target into the
# merger so the rendered template lands intact — same code path, no
# branching, and the next re-run is idempotent.
if [ "$install_hooks" -eq 1 ]; then
  do_merge_install \
    "$TEMPLATES_DIR/claude/settings.json" \
    "$WORKSPACE_DIR/.claude/settings.json" \
    "hooks"
fi

# ---------- skills + rules ----------
# templates/skills/*.md is rendered into both .claude/skills/ (for Claude Code,
# only when --install-hooks) and .agents/rules/ (vendor-neutral, always).
# Re-renders overwrite; the source is the canonical version.
skills_src="$TEMPLATES_DIR/skills"
if [ -d "$skills_src" ]; then
  rules_dst="$WORKSPACE_DIR/.agents/rules"
  mkdir -p "$rules_dst"
  while IFS= read -r -d '' file; do
    rel="${file#$skills_src/}"
    render "$file" > "$rules_dst/$rel"
  done < <(find "$skills_src" -type f -name '*.md' -print0)

  if [ "$install_hooks" -eq 1 ]; then
    claude_skills_dst="$WORKSPACE_DIR/.claude/skills"
    mkdir -p "$claude_skills_dst"
    while IFS= read -r -d '' file; do
      rel="${file#$skills_src/}"
      render "$file" > "$claude_skills_dst/$rel"
    done < <(find "$skills_src" -type f -name '*.md' -print0)
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
                                                  the five dataset slots (daily,
                                                  knowledge, plans, investigations,
                                                  self_improvement), install per-doc
                                                  metadata schema, optionally absorb
                                                  existing docs.
  5) ./memory/scripts/mcp-smoke.sh               # validate

The boilerplate ships with its own .git so you can update it later:
  cd memory && git pull && cd .. && ./memory/bootstrap.sh --slug $slug

Re-running bootstrap is idempotent. memory/.env is preserved across upgrades.
EOF
