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
WORKSPACE_DIR="$(cd "$MEMORY_DIR/.." && pwd -P)"
DIFY_DIR="$MEMORY_DIR/vendor/dify"
DIFY_DOCKER_DIR="$DIFY_DIR/docker"
MEMORY_ENV="$MEMORY_DIR/.env"

# Refuse to run if WORKSPACE_DIR is the user's home directory or root.
# Happens when the boilerplate was cloned at the repo root (`git clone … .`
# instead of `git clone … ./memory`), which would bind-mount $HOME (or /)
# into the bridge container at /workspace.
case "$WORKSPACE_DIR" in
  "$HOME"|/|/root)
    echo "FATAL: WORKSPACE_DIR resolves to '$WORKSPACE_DIR', which is your home or root." >&2
    echo "  Clone the boilerplate INTO a project subdirectory:" >&2
    echo "    cd ~/your-project && git clone <repo> ./memory" >&2
    echo "  Do not git clone the boilerplate AS the project root." >&2
    exit 1
    ;;
esac

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
  local configured_memory_data_dir

  configured_project_name="${COMPOSE_PROJECT_NAME:-}"
  if [ -z "$configured_project_name" ]; then
    configured_project_name="$(read_env_value COMPOSE_PROJECT_NAME "$MEMORY_ENV" 2>/dev/null || true)"
  fi

  configured_memory_data_dir="${MEMORY_DATA_DIR:-}"
  if [ -z "$configured_memory_data_dir" ]; then
    configured_memory_data_dir="$(read_env_value MEMORY_DATA_DIR "$MEMORY_ENV" 2>/dev/null || true)"
  fi

  if [ -z "$configured_project_name" ] || [ "$configured_project_name" = "__COMPOSE_PROJECT_NAME__" ]; then
    echo "FATAL: COMPOSE_PROJECT_NAME not configured." >&2
    echo "  Run ./memory/bootstrap.sh --slug <project-slug> first; it writes COMPOSE_PROJECT_NAME to memory/.env." >&2
    exit 1
  fi

  export MEMORY_DIR
  export MEMORY_ENV
  export WORKSPACE_DIR
  export DIFY_DOCKER_DIR
  export MEMORY_DATA_DIR="${configured_memory_data_dir:-$WORKSPACE_DIR/.memory}"
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
