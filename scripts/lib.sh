#!/usr/bin/env bash
set -euo pipefail

# `pwd -P` resolves symlinks. Required because:
#   1. macOS users with iCloud-synced Documents see project paths under
#      ~/Library/Mobile Documents/... that get symlinked to ~/Documents.
#      bare `pwd` would return the symlink form, but bootstrap.sh
#      resolves with `pwd -P` and writes the real path into compose env.
#      The two must agree or compose bind-mount paths drift.
#   2. Linux dev VMs commonly bind-mount the host project via a symlink.
#      Same drift risk.
#   3. The HOME-guard check below relies on string equality with $HOME,
#      which is the resolved (non-symlinked) form on every platform.
MEMORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# Resolve the project root from the clone location. In the installed layout the
# clone is <project>/.memory/src, so the project root is TWO levels up. In a
# bare repo checkout (developing/releasing the boilerplate) or a legacy
# pre-0.4.0 install at <project>/memory, it is ONE level up. Detect the
# installed layout (clone basename "src" under a ".memory" parent) and pick the
# matching depth; otherwise fall back to the parent. This keeps WORKSPACE_DIR
# correct for fresh installs, legacy installs, and repo-dev workflows alike,
# without a refuse-to-run guard.
if [ "$(basename "$MEMORY_DIR")" = "src" ] && [ "$(basename "$(dirname "$MEMORY_DIR")")" = ".memory" ]; then
  WORKSPACE_DIR="$(cd "$MEMORY_DIR/../.." && pwd -P)"
else
  WORKSPACE_DIR="$(cd "$MEMORY_DIR/.." && pwd -P)"
fi
DIFY_DIR="$MEMORY_DIR/vendor/dify"
DIFY_DOCKER_DIR="$DIFY_DIR/docker"

# The canonical user env file lives under the durable, gitignored data dir
# (./.memory/settings/.env), NOT inside ./.memory/src, so it survives removing or
# re-cloning ./.memory/src and there is exactly ONE .env. .memory/src/.env.example is
# the template. The data dir is resolved from an EXPORTED MEMORY_DATA_DIR or
# the default; it cannot be read from inside the env file to locate the env
# file (chicken-and-egg), so relocating the data dir requires exporting
# MEMORY_DATA_DIR before running any script.
MEMORY_DATA_DIR_DEFAULT="${MEMORY_DATA_DIR:-$WORKSPACE_DIR/.memory}"
MEMORY_SETTINGS_DIR="$MEMORY_DATA_DIR_DEFAULT/settings"
MEMORY_ENV="$MEMORY_SETTINGS_DIR/.env"
DIFY_VERSION_FILE_DEFAULT="$MEMORY_SETTINGS_DIR/.dify-version"

# Refuse to run if WORKSPACE_DIR is the user's home directory or root.
# Happens when the boilerplate was cloned at the repo root (`git clone … .`
# instead of `git clone … ./.memory/src`), which would bind-mount $HOME (or /)
# into the bridge container at /workspace.
#
# WORKSPACE_DIR is `pwd -P`-resolved above, so we must compare against BOTH
# $HOME and the resolved form of $HOME. On Linux it is common for $HOME to
# itself be a symlink (e.g. /home/foo -> /mnt/data/foo); without resolving,
# the string comparison would miss and the guard would silently fail.
# ${HOME:-} throughout: this file runs under `set -u` and HOME can be unset
# in minimal environments (env -i, some CI/cron). When HOME is empty the
# home-equality arms simply never match (an empty WORKSPACE_DIR is impossible
# here, it is pwd -P-resolved), and the / and /root arms still guard root.
home_resolved="$(cd "${HOME:-/nonexistent}" 2>/dev/null && pwd -P 2>/dev/null || echo "${HOME:-}")"
case "$WORKSPACE_DIR" in
  "${HOME:-/nonexistent-home}"|"${home_resolved:-/nonexistent-home}"|/|/root)
    echo "FATAL: WORKSPACE_DIR resolves to '$WORKSPACE_DIR', which is your home or root." >&2
    echo "  Clone the boilerplate INTO a project subdirectory:" >&2
    echo "    cd ~/your-project && git clone <repo> ./.memory/src" >&2
    echo "  Do not git clone the boilerplate AS the project root." >&2
    exit 1
    ;;
esac
unset home_resolved

# resolve_docker_bin: make `docker` callable even when it lives outside the
# non-interactive PATH. Rancher Desktop installs its shim at ~/.rd/bin/docker
# and only adds it to PATH via an interactive shell profile, so scripts run
# from cron/CI/agents (or a bare `bash script.sh`) see "docker missing" even
# though Docker works fine in the user's terminal. Colima and the in-app
# Rancher binary have the same problem. This resolver ONLY ADDS locations to
# PATH; it never blocks: if nothing is found it returns 0 so the caller's
# existing `require_cmd docker` / `command -v` check still emits the canonical
# install-guidance error. POSIX/bash-3.2 portable (macOS default bash).
resolve_docker_bin() {
  # ${PATH:-} / ${HOME:-} throughout: this runs under `set -u`, and PATH or
  # HOME can be unset in minimal environments (`env -i bash ...`, some
  # CI/cron). Referencing them bare would abort before the caller's
  # canonical require_cmd error. HOME-based candidates are skipped when HOME
  # is empty so we never probe "/.rd/bin/docker".
  # `local` keeps the temporaries out of the SOURCING shell (lib.sh is sourced,
  # not executed, so bare assignments would leak / collide with caller vars).
  local _dkr_dir candidate candidates
  # Explicit override wins.
  if [ -n "${DOCKER_BIN:-}" ] && [ -x "${DOCKER_BIN}" ]; then
    _dkr_dir="$(dirname "$DOCKER_BIN")"
    if [ -n "${PATH:-}" ]; then PATH="$_dkr_dir:$PATH"; else PATH="$_dkr_dir"; fi
    export PATH
    return 0
  fi

  # Already on PATH (the common case): do nothing.
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi

  # Probe common non-PATH locations; first executable wins. HOME-based
  # entries are only added when HOME is set.
  candidates="/usr/local/bin/docker
/opt/homebrew/bin/docker
/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker"
  if [ -n "${HOME:-}" ]; then
    candidates="$HOME/.rd/bin/docker
$HOME/.colima/default/bin/docker
$candidates"
  fi
  while IFS= read -r candidate; do
    # Defensively strip leading/trailing whitespace so a future edit that
    # accidentally indents an entry in the heredoc above can never bake a
    # leading space into the probed path. Internal spaces (the Rancher app
    # bundle path) are preserved. bash-3.2 portable.
    candidate="${candidate#"${candidate%%[![:space:]]*}"}"
    candidate="${candidate%"${candidate##*[![:space:]]}"}"
    [ -n "$candidate" ] || continue
    if [ -x "$candidate" ]; then
      export DOCKER_BIN="$candidate"
      _dkr_dir="$(dirname "$candidate")"
      if [ -n "${PATH:-}" ]; then PATH="$_dkr_dir:$PATH"; else PATH="$_dkr_dir"; fi
      export PATH
      # Quiet by default (lib.sh is sourced by scripts that emit machine-
      # readable output, e.g. mcp-config.sh). Set MEMORY_DEBUG=1 to surface.
      if [ -n "${MEMORY_DEBUG:-}" ]; then echo "lib.sh: using docker from $candidate" >&2; fi
      return 0
    fi
  done <<EOF
$candidates
EOF

  # Nothing found: let the caller's require_cmd emit the canonical error.
  return 0
}

read_env_value() {
  local key="$1"
  local file="${2:-$MEMORY_ENV}"

  if [ ! -f "$file" ]; then
    return 1
  fi

  grep -E "^${key}=" "$file" | tail -n 1 | sed "s/^${key}=//"
}

load_memory_env() {
  local configured_project_name

  configured_project_name="${COMPOSE_PROJECT_NAME:-}"
  if [ -z "$configured_project_name" ]; then
    configured_project_name="$(read_env_value COMPOSE_PROJECT_NAME "$MEMORY_ENV" 2>/dev/null || true)"
  fi

  if [ -z "$configured_project_name" ] || [ "$configured_project_name" = "__COMPOSE_PROJECT_NAME__" ]; then
    echo "FATAL: COMPOSE_PROJECT_NAME not configured." >&2
    echo "  Run $MEMORY_DIR/bootstrap.sh --slug <project-slug> first; it writes COMPOSE_PROJECT_NAME to ./.memory/settings/.env." >&2
    exit 1
  fi

  # MEMORY_DATA_DIR comes ONLY from the exported env var or the default (see
  # MEMORY_DATA_DIR_DEFAULT at the top). We deliberately do NOT read it from
  # the env file: MEMORY_ENV / MEMORY_SETTINGS_DIR / DIFY_VERSION_FILE_DEFAULT
  # are computed from it BEFORE this function runs, so letting the file
  # override it would make those paths disagree with where the file was found.
  # To relocate the data dir, export MEMORY_DATA_DIR before running scripts.
  export MEMORY_DIR
  export MEMORY_ENV
  export MEMORY_SETTINGS_DIR
  export DIFY_VERSION_FILE_DEFAULT
  export WORKSPACE_DIR
  export DIFY_DOCKER_DIR
  export MEMORY_DATA_DIR="$MEMORY_DATA_DIR_DEFAULT"
  export COMPOSE_PROJECT_NAME="$configured_project_name"
}

docker_compose() {
  load_memory_env

  if [ ! -f "$DIFY_DOCKER_DIR/docker-compose.yaml" ]; then
    echo "Dify is not bootstrapped. Run: $MEMORY_DIR/scripts/dify-bootstrap.sh" >&2
    exit 1
  fi

  docker compose \
    --env-file "$DIFY_DOCKER_DIR/.env" \
    --env-file "$MEMORY_ENV" \
    -p "$COMPOSE_PROJECT_NAME" \
    -f "$DIFY_DOCKER_DIR/docker-compose.yaml" \
    -f "$MEMORY_DIR/compose.mcp.yaml" \
    "$@"
}

# Resolve docker at sourcing time (once) so every script that sources lib.sh
# benefits before its prereq checks run. Guarded so re-sourcing is a no-op.
# Safe when sourced: side effects are limited to PATH/DOCKER_BIN; never exits.
[ -n "${_DOCKER_RESOLVED:-}" ] || { resolve_docker_bin; _DOCKER_RESOLVED=1; }
