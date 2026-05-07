#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/memory-template"

usage() {
  cat <<'USAGE'
Usage:
  ./install.sh [target-project-dir] [--slug project-slug] [--title "Project Title"] [--install-hooks] [--register-codex]

Installs the local Dify + MCP memory template into a project.

Defaults:
  target-project-dir  current directory
  project-slug        sanitized basename of target-project-dir
  title               title-cased project slug
  hooks               not installed unless --install-hooks is passed

The installer refuses to overwrite existing different files.
USAGE
}

target_dir=""
project_slug=""
project_title=""
register_codex=0
install_hooks=0

require_option_value() {
  local option="$1"
  local value="${2-}"

  if [ "$#" -lt 2 ] || [ -z "$value" ]; then
    echo "$option requires a non-empty value." >&2
    usage >&2
    exit 1
  fi

  case "$value" in
    --*)
      echo "$option requires a value, got option-looking argument: $value" >&2
      usage >&2
      exit 1
      ;;
  esac

  case "$value" in
    *$'\n'*|*$'\r'*|*$'\t'*)
      echo "$option value must not contain control characters." >&2
      usage >&2
      exit 1
      ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --slug)
      require_option_value "$1" "${2-}"
      project_slug="${2:-}"
      shift 2
      ;;
    --title)
      require_option_value "$1" "${2-}"
      project_title="${2:-}"
      shift 2
      ;;
    --register-codex)
      register_codex=1
      shift
      ;;
    --install-hooks)
      install_hooks=1
      shift
      ;;
    --no-hooks)
      install_hooks=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [ -n "$target_dir" ]; then
        echo "Only one target-project-dir is allowed." >&2
        usage >&2
        exit 1
      fi
      target_dir="$1"
      shift
      ;;
  esac
done

if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "Template directory not found: $TEMPLATE_DIR" >&2
  exit 1
fi

target_dir="${target_dir:-$PWD}"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd -P)"

sanitize_slug() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-//; s/-$//'
}

title_from_slug() {
  printf '%s' "$1" |
    tr '_-' '  ' |
    awk '{
      for (i = 1; i <= NF; i++) {
        $i = toupper(substr($i, 1, 1)) substr($i, 2)
      }
      print
    }'
}

raw_project_slug="${project_slug:-$(basename "$target_dir")}"
project_slug="$(sanitize_slug "$raw_project_slug")"
if [ -z "$project_slug" ]; then
  echo "Could not derive project slug. Pass --slug." >&2
  exit 1
fi

project_title="${project_title:-$(title_from_slug "$project_slug")}"
memory_server_name="${project_slug}-memory"
compose_project_name="${project_slug}-memory-stack"
mcp_image_name="${project_slug}-memory-mcp:local"

export PROJECT_SLUG="$project_slug"
export PROJECT_TITLE="$project_title"
export MEMORY_SERVER_NAME="$memory_server_name"
export COMPOSE_PROJECT_NAME="$compose_project_name"
export MCP_IMAGE_NAME="$mcp_image_name"

placeholder_mcp_rel=".agents/mcp/__MEMORY_SERVER_NAME__.mcp.json"

find_template_files() {
  find "$TEMPLATE_DIR" \
    \( -path '*/.git' -o -path '*/node_modules' -o -path '*/vendor/dify' \) -prune \
    -o -type f \
    ! -name '.DS_Store' \
    ! -name '.dify-version' \
    ! -name '.env' \
    -print0
}

find_template_dirs() {
  find "$TEMPLATE_DIR" \
    \( -path '*/.git' -o -path '*/node_modules' -o -path '*/vendor/dify' \) -prune \
    -o -type d \
    -print0
}

should_install_rel() {
  case "$1" in
    .agents/hooks.json|.claude/settings.json)
      [ "$install_hooks" -eq 1 ]
      ;;
    *)
      return 0
      ;;
  esac
}

should_create_dir() {
  case "$1" in
    .claude|.claude/*)
      [ "$install_hooks" -eq 1 ]
      ;;
    *)
      return 0
      ;;
  esac
}

target_rel_for() {
  if [ "$1" = "$placeholder_mcp_rel" ]; then
    printf '.agents/mcp/%s.mcp.json\n' "$memory_server_name"
  else
    printf '%s\n' "$1"
  fi
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

render_template() {
  local escaped_project_slug
  local escaped_project_title
  local escaped_memory_server_name
  local escaped_compose_project_name
  local escaped_mcp_image_name

  escaped_project_slug="$(escape_sed_replacement "$PROJECT_SLUG")"
  escaped_project_title="$(escape_sed_replacement "$PROJECT_TITLE")"
  escaped_memory_server_name="$(escape_sed_replacement "$MEMORY_SERVER_NAME")"
  escaped_compose_project_name="$(escape_sed_replacement "$COMPOSE_PROJECT_NAME")"
  escaped_mcp_image_name="$(escape_sed_replacement "$MCP_IMAGE_NAME")"

  sed \
    -e "s|__PROJECT_SLUG__|$escaped_project_slug|g" \
    -e "s|__PROJECT_TITLE__|$escaped_project_title|g" \
    -e "s|__MEMORY_SERVER_NAME__|$escaped_memory_server_name|g" \
    -e "s|__COMPOSE_PROJECT_NAME__|$escaped_compose_project_name|g" \
    -e "s|__MCP_IMAGE_NAME__|$escaped_mcp_image_name|g" \
    "$1"
}

conflicts_file="$(mktemp)"
trap 'rm -f "$conflicts_file"' EXIT

while IFS= read -r -d '' template_file; do
  rel_path="${template_file#$TEMPLATE_DIR/}"
  if ! should_install_rel "$rel_path"; then
    continue
  fi
  target_rel="$(target_rel_for "$rel_path")"
  target_file="$target_dir/$target_rel"
  if [ -f "$target_file" ]; then
    rendered_file="$(mktemp)"
    render_template "$template_file" > "$rendered_file"
    if ! cmp -s "$rendered_file" "$target_file"; then
      printf '%s\n' "$target_rel" >> "$conflicts_file"
    fi
    rm -f "$rendered_file"
  fi
done < <(find_template_files)

if [ -s "$conflicts_file" ]; then
  echo "Refusing to overwrite existing different files:" >&2
  sed 's/^/  - /' "$conflicts_file" >&2
  exit 1
fi

while IFS= read -r -d '' template_dir; do
  if [ "$template_dir" = "$TEMPLATE_DIR" ]; then
    continue
  fi
  rel_path="${template_dir#$TEMPLATE_DIR/}"
  if ! should_create_dir "$rel_path"; then
    continue
  fi
  mkdir -p "$target_dir/$rel_path"
done < <(find_template_dirs)

while IFS= read -r -d '' template_file; do
  rel_path="${template_file#$TEMPLATE_DIR/}"
  if ! should_install_rel "$rel_path"; then
    continue
  fi
  target_rel="$(target_rel_for "$rel_path")"
  target_file="$target_dir/$target_rel"
  mkdir -p "$(dirname "$target_file")"
  if [ ! -f "$target_file" ]; then
    render_template "$template_file" > "$target_file"
  fi
done < <(find_template_files)

gitignore_file="$target_dir/.gitignore"
gitignore_marker="# Local Dify MCP memory boilerplate"
touch "$gitignore_file"

ensure_trailing_newline() {
  if [ -s "$gitignore_file" ] && [ "$(tail -c 1 "$gitignore_file")" != "" ]; then
    printf '\n' >> "$gitignore_file"
  fi
}

ensure_gitignore_line() {
  local line="$1"
  if ! grep -qxF "$line" "$gitignore_file"; then
    ensure_trailing_newline
    printf '%s\n' "$line" >> "$gitignore_file"
  fi
}

if [ -s "$gitignore_file" ] && ! grep -qxF "$gitignore_marker" "$gitignore_file"; then
  ensure_trailing_newline
  printf '\n' >> "$gitignore_file"
fi

ensure_gitignore_line "$gitignore_marker"
ensure_gitignore_line "memory/.env"
ensure_gitignore_line "memory/vendor/*"
ensure_gitignore_line "!memory/vendor/.keep"
ensure_gitignore_line ".memory/dify/*"
ensure_gitignore_line "!.memory/dify/.keep"

chmod +x "$target_dir"/memory/scripts/*.sh "$target_dir"/memory/scripts/hooks/*.sh 2>/dev/null || true

if [ "$register_codex" -eq 1 ]; then
  if ! command -v codex >/dev/null 2>&1; then
    echo "codex CLI not found; skipping Codex MCP registration." >&2
  elif codex mcp get "$memory_server_name" >/dev/null 2>&1; then
    echo "Codex MCP server already registered: $memory_server_name"
  else
    codex mcp add "$memory_server_name" -- docker exec -i "$memory_server_name" node src/index.js
  fi
fi

cat <<EOF
Installed memory template into: $target_dir

Project slug:          $project_slug
Memory MCP server:     $memory_server_name
Compose project name:  $compose_project_name
Active hooks installed: $([ "$install_hooks" -eq 1 ] && printf 'yes' || printf 'no')

Next steps:
  cd "$target_dir"
  ./memory/scripts/up.sh
  ./memory/scripts/ui-url.sh

After Dify UI setup, edit memory/.env with:
  DIFY_KNOWLEDGE_API_KEY=...
  DIFY_DATASET_IDS=...
  DIFY_WRITE_DATASET_ID=...

Then restart only the MCP bridge:
  ./memory/scripts/up.sh "$memory_server_name"

Codex MCP registration, if not already done:
  codex mcp add "$memory_server_name" -- docker exec -i "$memory_server_name" node src/index.js
EOF

if [ "$install_hooks" -eq 0 ]; then
  cat <<EOF

Continuous memory hooks were not installed. To add active hook config later:
  "$SCRIPT_DIR/install.sh" "$target_dir" --slug "$project_slug" --install-hooks
EOF
fi
