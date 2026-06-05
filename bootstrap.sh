#!/usr/bin/env bash
set -euo pipefail

# Renders project-root files (.agents/, .claude/settings.json, .gitignore block)
# from templates inside the cloned boilerplate, and creates the canonical env
# at ./.memory/settings/.env from .memory/src/.env.example. Idempotent: safe to
# re-run after `cd .memory/src && git pull` (existing settings/.env values are
# preserved; new template keys are merged in).

MEMORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# bootstrap.sh sits at the clone root. Installed layout (<project>/.memory/src)
# -> project root is TWO levels up; a bare repo checkout or a legacy
# <project>/memory install -> ONE level up. Detect "src" under a ".memory"
# parent and pick the matching depth (mirrors scripts/lib.sh) so WORKSPACE_DIR
# is correct in every context without a refuse-to-run guard.
if [ "$(basename "$MEMORY_DIR")" = "src" ] && [ "$(basename "$(dirname "$MEMORY_DIR")")" = ".memory" ]; then
  WORKSPACE_DIR="$(cd "$MEMORY_DIR/../.." && pwd -P)"
else
  WORKSPACE_DIR="$(cd "$MEMORY_DIR/.." && pwd -P)"
fi
TEMPLATES_DIR="$MEMORY_DIR/templates"

usage() {
  cat <<'USAGE'
Usage:
  ./.memory/src/bootstrap.sh --slug <project-slug> [options]

Options:
  --slug <slug>            Project slug (lowercase a-z, 0-9, -). Auto-derived
                           from the parent directory name if not supplied.
  --title "<title>"        Display title (default: title-cased slug).
  --llm-provider <p>       claude | codex | anthropic | openai | ask (default: ask)
  --install-hooks          Install Claude Code hooks (default: on).
  --no-hooks               Skip Claude Code hook install.
  --register-codex         If codex CLI present, register the MCP server.
  --no-interactive         Skip all prompts; auto-select defaults. When multiple
                           LLM providers are detected, use --llm-provider to
                           specify one explicitly or the first detected is used.
  --schedule <daily|off>   Install (daily) or remove (off) the HOURLY maintenance
                           cron: compile + consolidate --if-due (launchd on macOS,
                           crontab on Linux). Omit to leave crons untouched.
  -h, --help               This help.

Run from the user-project root after `git clone <boilerplate> ./.memory/src`.
USAGE
}

slug=""
title=""
llm_provider="ask"
provider_explicit=0   # set when the user passes --llm-provider explicitly
install_hooks=1
register_codex=0
interactive=1
schedule=""

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
    --llm-provider) require_value "$1" "${2-}"; llm_provider="$2"; provider_explicit=1; shift 2 ;;
    --install-hooks) install_hooks=1; shift ;;
    --no-hooks) install_hooks=0; shift ;;
    --register-codex) register_codex=1; shift ;;
    --no-interactive) interactive=0; shift ;;
    --schedule) require_value "$1" "${2-}"; schedule="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# Validate --schedule at PARSE time, before any side-effecting work (template
# render/merge, .gitignore + .env writes, schema install). Otherwise an invalid
# value only failed at the very end, after the install had already run.
case "${schedule:-}" in
  ""|daily|off) : ;;
  *) echo "Invalid --schedule '$schedule' (use 'daily' or 'off')." >&2; exit 2 ;;
esac

# ---------- prereq checks ----------
require_cmd() {
  local cmd="$1" hint="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing prerequisite: $cmd ($hint)" >&2
    exit 1
  fi
}

# bootstrap.sh is intentionally standalone (it must run before lib.sh is
# usable / before any clone), so we INLINE a minimal copy of lib.sh's
# resolve_docker_bin here. Rationale: Rancher Desktop's shim at ~/.rd/bin is
# only added to PATH by an interactive shell profile, so a non-interactive
# `./.memory/src/bootstrap.sh` falsely reports "docker missing". Colima and the
# in-app Rancher binary have the same problem. This ONLY ADDS locations to
# PATH; if nothing is found it returns without error so the require_cmd below
# still emits the canonical install-guidance message.
# ${PATH:-} / ${HOME:-} throughout: bootstrap runs under `set -u` and either
# can be unset in minimal environments (`env -i`, some automation). Bare refs
# would abort before the require_cmd docker message. HOME-based candidates are
# skipped when HOME is empty.
resolve_docker_bin() {
  # `local` keeps the temporaries out of the script's global scope (parity
  # with the lib.sh copy) so they can't collide with later vars.
  local _dkr_dir candidate candidates
  if [ -n "${DOCKER_BIN:-}" ] && [ -x "${DOCKER_BIN}" ]; then
    _dkr_dir="$(dirname "$DOCKER_BIN")"
    if [ -n "${PATH:-}" ]; then PATH="$_dkr_dir:$PATH"; else PATH="$_dkr_dir"; fi
    export PATH
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  candidates="/usr/local/bin/docker
/opt/homebrew/bin/docker
/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker"
  if [ -n "${HOME:-}" ]; then
    candidates="$HOME/.rd/bin/docker
$HOME/.colima/default/bin/docker
$candidates"
  fi
  while IFS= read -r candidate; do
    # Defensively trim leading/trailing whitespace so an accidental indent in
    # the heredoc can never bake a leading space into the probed path; the
    # Rancher app bundle's internal spaces are preserved. bash-3.2 portable.
    candidate="${candidate#"${candidate%%[![:space:]]*}"}"
    candidate="${candidate%"${candidate##*[![:space:]]}"}"
    [ -n "$candidate" ] || continue
    if [ -x "$candidate" ]; then
      export DOCKER_BIN="$candidate"
      _dkr_dir="$(dirname "$candidate")"
      if [ -n "${PATH:-}" ]; then PATH="$_dkr_dir:$PATH"; else PATH="$_dkr_dir"; fi
      export PATH
      if [ -n "${MEMORY_DEBUG:-}" ]; then echo "bootstrap.sh: using docker from $candidate" >&2; fi
      return 0
    fi
  done <<EOF
$candidates
EOF
  return 0
}
resolve_docker_bin

require_cmd docker "install Docker Desktop or docker engine"
require_cmd node "install Node.js 20+"

compose_version="$(docker compose version --short 2>/dev/null || true)"
if [ -z "$compose_version" ]; then
  echo "docker compose not available. Install Docker Compose 2.24.4+." >&2
  exit 1
fi
required_compose="2.24.4"
# Portable semver GTE check — avoids GNU-only `sort -V` (not available on macOS/BSD).
version_gte() {
  local a="$1" b="$2"
  local a1 a2 a3 b1 b2 b3 IFS='.'
  # shellcheck disable=SC2086
  set -- $a; a1="${1:-0}"; a2="${2:-0}"; a3="${3:-0}"
  # shellcheck disable=SC2086
  set -- $b; b1="${1:-0}"; b2="${2:-0}"; b3="${3:-0}"
  if   [ "$a1" -gt "$b1" ]; then return 0
  elif [ "$a1" -lt "$b1" ]; then return 1
  elif [ "$a2" -gt "$b2" ]; then return 0
  elif [ "$a2" -lt "$b2" ]; then return 1
  elif [ "$a3" -ge "$b3" ]; then return 0
  else return 1
  fi
}
if ! version_gte "$compose_version" "$required_compose"; then
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
    echo "      Defaulting to MEMORY_LLM_PROVIDER=claude. Edit ./.memory/settings/.env to change." >&2
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

  # Also register the memory MCP server in Claude Code's project-scope
  # MCP config at <workspace>/.mcp.json. Without this step the bridge
  # container is up and the tools work, but Claude Code's `/mcp`
  # command never sees the `<slug>-memory` server because Claude Code
  # reads MCP configs from `.mcp.json` (project) or `~/.claude.json`
  # (user-global), NOT from `.agents/mcp.json` (vendor-neutral). The
  # vendor-neutral file is rendered too (above) for non-Claude
  # clients (Cursor, Codex/OpenAI, etc).
  #
  # Same merge contract as `.agents/mcp.json` — preserves any other
  # MCP servers the user already has at project scope, only owns the
  # `<slug>-memory` key. Idempotent on re-run.
  do_merge_install \
    "$TEMPLATES_DIR/agents/mcp.json" \
    "$WORKSPACE_DIR/.mcp.json" \
    "mcp"
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

# ---------- canonical env: ./.memory/settings/.env ----------
# The single user env file lives in the durable, gitignored data dir, NOT in
# ./.memory/src, so it survives removing/re-cloning ./.memory/src and there is exactly
# ONE .env. .memory/src/.env.example is the only template. Resolve the settings dir
# from an exported MEMORY_DATA_DIR or the default (at first bootstrap there is
# no env file yet to read a custom data dir from; export it to relocate).
settings_data_dir="${MEMORY_DATA_DIR:-$WORKSPACE_DIR/.memory}"
settings_dir="$settings_data_dir/settings"
env_file="$settings_dir/.env"
legacy_env="$MEMORY_DIR/.env"   # pre-0.3.0 canonical location
mkdir -p "$settings_dir"

# Set KEY=VALUE as the SINGLE canonical line: delete every existing KEY= line
# (active or duplicated by a prior install/edit) then append exactly one. This
# guarantees the last/effective value (read_env_value uses `tail -n 1`) is the
# reconciled one regardless of duplicates.
set_env_unique() {
  local key="$1" value="$2" file="$3" tmp rc eol
  # Fail fast if the file exists but can't be read: rewriting from an empty
  # grep would otherwise truncate it and silently drop secrets (the API key,
  # dataset bindings). Better to abort and let the user fix ownership/perms.
  if [ -e "$file" ] && [ ! -r "$file" ]; then
    echo "FATAL: $file is not readable; refusing to rewrite it (would drop your key/bindings). Fix its ownership/permissions and re-run." >&2
    exit 1
  fi
  # Match the file's existing newline style so a Windows-edited CRLF file
  # doesn't end up with a lone-LF canonical line (mixed endings). grep keeps
  # the CR on surviving lines; we only need the right EOL for the appended one.
  eol=$'\n'
  if [ -f "$file" ] && grep -q $'\r' "$file" 2>/dev/null; then eol=$'\r\n'; fi
  # Explicit template: portable across GNU and BSD/macOS mktemp.
  tmp="$(mktemp "${TMPDIR:-/tmp}/memory-env.XXXXXX")"
  if [ -f "$file" ]; then
    # grep exit 1 (no surviving lines, e.g. the file held only this key) is
    # fine; exit >=2 is a real read error, so abort instead of truncating.
    set +e
    grep -vE "^${key}=" "$file" > "$tmp"
    rc=$?
    set -e
    if [ "$rc" -ge 2 ]; then
      echo "FATAL: failed to read $file while updating $key; aborting to avoid data loss." >&2
      rm -f "$tmp"
      exit 1
    fi
  fi
  printf '%s=%s%s' "$key" "$value" "$eol" >> "$tmp"
  mv "$tmp" "$file"
}

# Migrate a pre-0.3.0 install: if the new settings/.env does not exist yet but
# a legacy .memory/src/.env does, move its contents across (keeps the user's key +
# bindings). If BOTH exist they may diverge; settings/.env is the new canonical
# and wins, but warn so the user can reconcile. The legacy file is removed at
# the end either way, so there is exactly one .env.
migrated=0
if [ ! -f "$env_file" ] && [ -f "$legacy_env" ]; then
  if cp "$legacy_env" "$env_file" 2>/dev/null; then
    migrated=1
  else
    # Hard-fail rather than fall through to rendering a blank template, which
    # would silently drop the user's existing API key + dataset bindings.
    echo "FATAL: found legacy env at $legacy_env but could not copy it to $env_file." >&2
    echo "  Refusing to render a blank env over your existing key/bindings." >&2
    echo "  Fix permissions on $settings_dir (or copy the file manually) and re-run." >&2
    exit 1
  fi
elif [ -f "$env_file" ] && [ -f "$legacy_env" ] && ! cmp -s "$env_file" "$legacy_env"; then
  echo "warning: both $legacy_env (legacy) and $env_file exist and differ; keeping $env_file as canonical and removing the legacy file. Verify your key/bindings if needed." >&2
fi

if [ ! -f "$env_file" ]; then
  # Fresh install: render the template (substitutes the identity placeholders).
  render "$MEMORY_DIR/.env.example" > "$env_file"
  env_action="created"
else
  # Existing settings/.env: merge any keys added to .env.example upstream so a
  # `git pull` upgrade surfaces new knobs without a hand-diff. Append-only.
  # Don't hard-fail the install on a merge error (the existing env is still
  # usable), but warn loudly and reflect it in env_action so the user knows
  # new keys may not have landed.
  if node "$MEMORY_DIR/scripts/lib/merge-env.mjs" "$MEMORY_DIR/.env.example" "$env_file"; then
    merge_ok=1
  else
    merge_ok=0
    echo "warning: merge-env.mjs failed; new keys from .env.example may NOT have been merged into $env_file (your existing settings are intact). Re-run bootstrap or merge manually." >&2
  fi
  if [ "$migrated" -eq 1 ]; then
    env_action="migrated from .memory/src/.env"
  elif [ "$merge_ok" -eq 1 ]; then
    env_action="updated"
  else
    env_action="updated (merge failed; see warning)"
  fi
fi

# Reconcile identity fields from the CURRENT --slug. On a fresh render they are
# already correct (render substitutes them); on migrate/upgrade they may carry
# a prior slug. set_env_unique guarantees one canonical line per key.
existing_project_name="$(grep -E '^COMPOSE_PROJECT_NAME=' "$env_file" | tail -n 1 | sed 's/^COMPOSE_PROJECT_NAME=//' || true)"
if [ -n "$existing_project_name" ] && [ "$existing_project_name" != "$compose_project_name" ]; then
  echo "warning: env was written under a different slug (COMPOSE_PROJECT_NAME was '$existing_project_name'); re-deriving identity fields for '$slug'. Dataset bindings and API key are kept." >&2
fi
set_env_unique COMPOSE_PROJECT_NAME "$compose_project_name" "$env_file"
set_env_unique MCP_CONTAINER_NAME "$memory_server_name" "$env_file"
set_env_unique MCP_IMAGE_NAME "$mcp_image_name" "$env_file"

# Reconcile MEMORY_LLM_PROVIDER: an explicit --llm-provider wins (write it in);
# otherwise adopt the value already in the file so the summary reflects the
# effective config, not the auto-detected default.
if [ "$provider_explicit" -eq 1 ]; then
  set_env_unique MEMORY_LLM_PROVIDER "$llm_provider" "$env_file"
else
  existing_provider="$(grep -E '^MEMORY_LLM_PROVIDER=' "$env_file" | tail -n 1 | sed 's/^MEMORY_LLM_PROVIDER=//' || true)"
  if [ -n "$existing_provider" ]; then llm_provider="$existing_provider"; fi
fi

# Tighten perms (the file carries the Dify API key once dify-setup.sh runs).
chmod 600 "$env_file" 2>/dev/null || \
  echo "warning: could not chmod 600 $env_file; it carries the API key and may be readable by others." >&2

# Exactly one canonical .env: remove any legacy clone-root .env ($legacy_env)
# now that settings/.env owns it.
if [ -f "$legacy_env" ]; then
  rm -f "$legacy_env" && echo "Removed legacy env at $legacy_env; the canonical env is now $env_file."
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
  settings/.env:       $env_action ($env_file)

Your config (API key, dataset bindings, env knobs) lives in:
  $env_file
Edit THAT file, not $legacy_env (the legacy clone-root .env, which no longer
exists). The template is $MEMORY_DIR/.env.example; new keys added there are
merged in on the next bootstrap.

Next steps:
  1) ./.memory/src/scripts/up.sh                     # start the Dify stack
                                                  (FIRST RUN: 2-5 minutes on a
                                                   cold Docker image pull
                                                   (multi-GB); ~30-60s once the
                                                   image cache is warm.)
  2) ./.memory/src/scripts/ui-url.sh                 # open the printed URL
  3) In Dify UI: create the admin account.
     Then Settings -> Model Provider:
       - select OpenAI (recommended) or Ollama (for local zero-cost embeddings)
       - install the plugin if it isn't already, paste your API key
       - System Model Settings: set as the DEFAULT Embedding Model
         (text-embedding-3-small for OpenAI, bge-m3 for Ollama)
     Then Knowledge -> Service API -> create a Knowledge API key.
     (Do NOT paste the key by hand; the next step's wizard prompts for it
      and writes it into ./.memory/settings/.env for you.)
  4) ./.memory/src/scripts/dify-setup.sh              # paste the Knowledge API key
                                                  when prompted; auto-create
                                                  the configured dataset slots
                                                  (defaults: daily, knowledge,
                                                  plans, investigations,
                                                  self_improvement; add more by
                                                  appending DIFY_DATASET_<NAME>_ID=
                                                  to ./.memory/settings/.env), install per-
                                                  doc metadata schema, restart
                                                  the bridge to pick up the new
                                                  env, optionally absorb existing
                                                  docs.
  5) Restart your MCP client so it picks up the new memory MCP server.
     Where it's registered:
       - Claude Code: project-scope ./.mcp.json (auto-written by bootstrap)
       - Cursor / Codex / Claude Desktop: copy the relevant snippet from
         ./.agents/clients/ into the client's own MCP config, OR run
         \`./.memory/src/scripts/mcp-config.sh all\` to print them again.
     The server only becomes callable from inside an agent session
     AFTER this client restart.
  6) ./.memory/src/scripts/mcp-smoke.sh               # validate

Plan-mode integration (Claude Code only; other clients can ignore):
  When you exit plan mode and approve a plan, the PostToolUse hook
  upserts plan-<slug>.md into the 'plans' dataset slot automatically
  (no LLM, multiple bridge round-trips, typically ~1-2s). Same plan
  title overwrites in place. Set MEMORY_HOOK_EXITPLANMODE_DISABLE=true
  in ./.memory/settings/.env to opt out. See templates/skills/plan-capture.md
  for the agent contract.

The boilerplate ships with its own .git so you can update it later:
  cd .memory/src && git pull && cd .. && ./.memory/src/bootstrap.sh --slug $slug

Re-running bootstrap is idempotent. Your ./.memory/settings/.env is preserved
across upgrades (new template keys are merged in, existing values untouched).
EOF

# If a prior install recorded an embedding model, remind the user to
# configure the SAME one in the Dify UI so retrieval stays consistent.
# Non-fatal if absent.
settings_embed="${settings_data_dir:-$WORKSPACE_DIR/.memory}/settings/embedding-model.txt"
if [ -f "$settings_embed" ]; then
  echo
  echo "Recorded embedding model from your prior install ($settings_embed):"
  sed 's/^/  /' "$settings_embed"
  echo "  -> set the SAME embedding model as the System Default in the Dify UI."
fi

# ---------- optional: hourly maintenance cron ----------
# Installs an HOURLY job (launchd on macOS, crontab on Linux) that runs
# scripts/cron-job.mjs: compile + consolidate --if-due. The heavy work is
# self-throttled (compile per-UTC-day, consolidate per MEMORY_CONSOLIDATE_
# INTERVAL_DAYS), so hourly attempts do real work at most once per day and each
# attempt is logged to .memory/state/.consolidate-attempts.log (the cron_health
# MCP tool reads it). Idempotent: re-running replaces the prior job cleanly.
schedule_job() {
  local action="$1"
  # Honor a relocated durable data dir; fall back to the default. Mirrors
  # scripts/lib.sh + env.mjs (${MEMORY_DATA_DIR:-$WORKSPACE_DIR/.memory}).
  local data_dir="${MEMORY_DATA_DIR:-$WORKSPACE_DIR/.memory}"
  local node_bin
  node_bin="$(command -v node || echo node)"
  local job_cmd="\"$node_bin\" \"$MEMORY_DIR/scripts/cron-job.mjs\""
  # launchd / cron run with a MINIMAL PATH (typically /usr/bin:/bin:/usr/sbin:
  # /sbin) that lacks both node and docker, so the job's `docker exec` to the
  # bridge would fail with "spawn docker ENOENT". Build an explicit PATH that
  # includes node's dir, the resolved docker dir, and the common docker
  # locations (Rancher Desktop's ~/.rd/bin, Homebrew, /usr/local/bin).
  local docker_bin docker_dir cron_path
  docker_bin="$(command -v docker 2>/dev/null || true)"
  docker_dir="$(cd "$(dirname "${docker_bin:-/usr/local/bin/docker}")" 2>/dev/null && pwd -P || echo /usr/local/bin)"
  cron_path="$(dirname "$node_bin"):$docker_dir:${HOME:-}/.rd/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local ws_hash
  ws_hash="$(printf '%s' "$WORKSPACE_DIR" | cksum | awk '{print $1}')"

  if [ "$(uname)" = "Darwin" ]; then
    if ! command -v launchctl >/dev/null 2>&1; then
      echo "WARNING: launchctl not available; skipping schedule setup." >&2
      return 0
    fi
    local label="com.ctxr-memory.$ws_hash"
    local plist="$HOME/Library/LaunchAgents/$label.plist"
    launchctl unload "$plist" >/dev/null 2>&1 || true
    if [ "$action" = "off" ]; then
      rm -f "$plist"
      echo "Removed scheduled maintenance job ($label)."
      return 0
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    # XML-escape every value interpolated into the plist: a workspace path with
    # & < or > (all legal in macOS dir names) would otherwise produce malformed
    # XML that launchctl silently rejects. Order matters: & MUST be first.
    local x_label="$label" x_data="$data_dir" x_path="$cron_path" x_cmd="$job_cmd"
    x_label="${x_label//&/&amp;}"; x_label="${x_label//</&lt;}"; x_label="${x_label//>/&gt;}"
    x_data="${x_data//&/&amp;}";   x_data="${x_data//</&lt;}";   x_data="${x_data//>/&gt;}"
    x_path="${x_path//&/&amp;}";   x_path="${x_path//</&lt;}";   x_path="${x_path//>/&gt;}"
    x_cmd="${x_cmd//&/&amp;}";     x_cmd="${x_cmd//</&lt;}";     x_cmd="${x_cmd//>/&gt;}"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$x_label</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MEMORY_DATA_DIR</key>
    <string>$x_data</string>
    <key>PATH</key>
    <string>$x_path</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>$x_cmd</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
</dict>
</plist>
PLIST
    launchctl load "$plist" >/dev/null 2>&1 || true
    echo "Installed hourly maintenance cron (launchd, every hour at :00): $plist"
  else
    if ! command -v crontab >/dev/null 2>&1; then
      echo "WARNING: crontab not available; skipping schedule setup." >&2
      return 0
    fi
    # Match key is the %-free, stable workspace hash (NOT the raw path): the
    # installed line is %-escaped before writing (cron treats % as a newline), so
    # a raw-path tag containing % would be written as "\%" but matched here as
    # "%", leaving the old entry behind (duplicate on reinstall / fails to remove
    # on --schedule off). The hash has no % or quotes, so grep -vF matches the
    # installed line reliably; the human-readable path stays in the comment.
    # The TRAILING colon delimiter is load-bearing: cksum is a variable-length
    # decimal CRC, so without it one workspace whose hash is a prefix of another's
    # (e.g. 123 vs 1234) would have its cron line deleted by the other's substring
    # grep -vF. The installed comment always has ":$ws_hash:" so the match is exact.
    local tag_match="# ctxr-memory:$ws_hash:"
    local tag="$tag_match$WORKSPACE_DIR"
    local wrapper="$data_dir/state/cron-maintenance.sh"
    local filtered
    filtered="$(crontab -l 2>/dev/null | grep -vF "$tag_match" || true)"
    if [ "$action" = "off" ]; then
      printf '%s\n' "$filtered" | grep -v '^$' | crontab - 2>/dev/null || true
      rm -f "$wrapper"
      echo "Removed scheduled maintenance job (crontab) + wrapper."
      return 0
    fi
    # A wrapper script keeps env + the node command out of the cron line, where
    # '%' and quotes in paths would otherwise break (cron treats '%' as newline).
    mkdir -p "$(dirname "$wrapper")"
    cat > "$wrapper" <<WRAPPER
#!/usr/bin/env bash
# Auto-generated by memory bootstrap.sh --schedule daily; invoked HOURLY by cron.
# cron-job.mjs handles compile + consolidate --if-due + attempt logging.
# Do NOT hand-edit; re-run bootstrap.sh to regenerate.
set -u
export MEMORY_DATA_DIR="$data_dir"
export PATH="$cron_path"
exec "$node_bin" "$MEMORY_DIR/scripts/cron-job.mjs"
WRAPPER
    chmod +x "$wrapper"
    local line="0 * * * * \"$wrapper\" $tag"
    # cron treats '%' in the command/comment as a newline (even when quoted), so a
    # wrapper path or workspace tag containing '%' would corrupt the crontab.
    # Escape every '%' as '\%' in the cron line.
    line="${line//%/\\%}"
    { printf '%s\n' "$filtered" | grep -v '^$'; printf '%s\n' "$line"; } | crontab - \
      || echo "WARNING: failed to update crontab." >&2
    echo "Installed hourly maintenance cron (crontab, every hour at :00) via wrapper $wrapper"
  fi
}

# Create the state dir up front (owned by the invoking user) so the compose
# read-only bind mount (${MEMORY_DATA_DIR}/state -> /app/state) does not get a
# root-owned dir auto-created by docker, which the host cron could not write to.
mkdir -p "${MEMORY_DATA_DIR:-$WORKSPACE_DIR/.memory}/state"

case "${schedule:-}" in
  "") : ;;
  daily) schedule_job daily ;;
  off) schedule_job off ;;
  *) echo "Unknown --schedule '$schedule' (use 'daily' or 'off')." >&2; exit 2 ;;
esac

# Best-effort backfill of the consolidate/recall metadata fields on EXISTING
# datasets. Idempotent (skips fields already present). Non-fatal: if the bridge
# container is not up yet (the common case during a fresh bootstrap), this fails
# cleanly and we print the manual command to run once the stack is up.
echo
echo "Installing consolidate/recall metadata fields on bound datasets (best-effort)..."
# Do NOT suppress stderr: a real failure (bridge auth, misconfig, syntax error)
# must be visible, not hidden behind the generic fallback message below.
if node "$MEMORY_DIR/scripts/install-metadata-fields.mjs"; then
  :
else
  echo "  install-metadata-fields did not complete (see the error above)." >&2
  echo "  If the stack simply is not up yet, re-run once it is:" >&2
  echo "    node \"$MEMORY_DIR/scripts/install-metadata-fields.mjs\"" >&2
fi
