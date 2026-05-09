#!/usr/bin/env bash
set -euo pipefail

MEMORY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_DIR="$(cd "$MEMORY_DIR/.." && pwd)"
DIFY_DIR="$MEMORY_DIR/vendor/dify"
DIFY_DOCKER_DIR="$DIFY_DIR/docker"
MEMORY_ENV="$MEMORY_DIR/.env"

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

  export MEMORY_DIR
  export WORKSPACE_DIR
  export DIFY_DOCKER_DIR
  export MEMORY_DATA_DIR="${configured_memory_data_dir:-$WORKSPACE_DIR/.memory}"
  export COMPOSE_PROJECT_NAME="${configured_project_name:-__COMPOSE_PROJECT_NAME__}"
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
