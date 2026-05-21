#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

set_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[&/\]/\\&/g')"

  if grep -q "^${key}=" "$file"; then
    sed -i.bak "s/^${key}=.*/${key}=${escaped}/" "$file"
    rm -f "${file}.bak"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

latest_dify_tag() {
  curl -fsSL https://api.github.com/repos/langgenius/dify/releases/latest |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
    head -n 1
}

version_ge() {
  local left="$1"
  local right="$2"
  local l1 l2 l3 r1 r2 r3

  IFS=. read -r l1 l2 l3 _ <<<"$left"
  IFS=. read -r r1 r2 r3 _ <<<"$right"

  l1="${l1:-0}"
  l2="${l2:-0}"
  l3="${l3:-0}"
  r1="${r1:-0}"
  r2="${r2:-0}"
  r3="${r3:-0}"

  if [ "$l1" -gt "$r1" ]; then
    return 0
  fi
  if [ "$l1" -eq "$r1" ] && [ "$l2" -gt "$r2" ]; then
    return 0
  fi
  if [ "$l1" -eq "$r1" ] && [ "$l2" -eq "$r2" ] && [ "$l3" -ge "$r3" ]; then
    return 0
  fi
  return 1
}

require_docker_compose() {
  local required_version="2.24.4"
  local raw_version
  local compose_version

  if ! docker compose version >/dev/null 2>&1; then
    echo "Missing required command: docker compose" >&2
    exit 1
  fi

  raw_version="$(docker compose version --short 2>/dev/null || docker compose version 2>/dev/null || true)"
  compose_version="$(printf '%s\n' "$raw_version" | grep -Eo '[0-9]+([.][0-9]+){1,3}' | head -n 1 || true)"

  if [ -z "$compose_version" ]; then
    echo "Could not determine Docker Compose version. Docker Compose ${required_version}+ is required." >&2
    exit 1
  fi

  if ! version_ge "$compose_version" "$required_version"; then
    echo "Docker Compose ${compose_version} is too old. Docker Compose ${required_version}+ is required." >&2
    exit 1
  fi
}

resolve_dify_version() {
  local requested_version
  local pinned_version

  requested_version="${DIFY_VERSION:-}"
  if [ -z "$requested_version" ]; then
    requested_version="$(read_env_value DIFY_VERSION "$MEMORY_ENV" 2>/dev/null || true)"
  fi

  if [ -n "$requested_version" ]; then
    printf '%s\n' "$requested_version"
    return
  fi

  # DIFY_VERSION_FILE is canonical under ./.memory/settings/, so it survives
  # removing/re-cloning ./memory; no separate snapshot to restore from.
  if [ -f "$DIFY_VERSION_FILE" ]; then
    pinned_version="$(sed -n 's/[[:space:]]//g; /^$/d; 1p' "$DIFY_VERSION_FILE")"
    if [ -n "$pinned_version" ]; then
      printf '%s\n' "$pinned_version"
      return
    fi
  fi

  latest_dify_tag
}

hash_secret_seed() {
  local seed="$1"

  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$seed" | shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$seed" | sha256sum | awk '{print $1}'
  else
    echo "Missing required command: openssl, shasum, or sha256sum" >&2
    exit 1
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    printf 'sk-%s' "$(openssl rand -base64 42 | tr -dc 'A-Za-z0-9' | cut -c1-42)"
  else
    printf 'sk-%s' "$(hash_secret_seed "$(date +%s)-$RANDOM-$RANDOM" | cut -c1-42)"
  fi
}

require_cmd docker
require_cmd git
require_cmd curl
require_docker_compose

load_memory_env
# .dify-version is canonical in the durable data dir (alongside settings/.env),
# so a re-clone of ./memory reuses the same pinned Dify tag.
DIFY_VERSION_FILE="$DIFY_VERSION_FILE_DEFAULT"

mkdir -p "$MEMORY_DIR/vendor" "$MEMORY_SETTINGS_DIR"
mkdir -p \
  "$MEMORY_DATA_DIR/dify/app/storage" \
  "$MEMORY_DATA_DIR/dify/db/data" \
  "$MEMORY_DATA_DIR/dify/redis/data" \
  "$MEMORY_DATA_DIR/dify/sandbox/dependencies" \
  "$MEMORY_DATA_DIR/dify/sandbox/conf" \
  "$MEMORY_DATA_DIR/dify/plugin_daemon" \
  "$MEMORY_DATA_DIR/dify/weaviate" \
  "$MEMORY_DATA_DIR/dify/certbot/conf/live" \
  "$MEMORY_DATA_DIR/dify/certbot/logs" \
  "$MEMORY_DATA_DIR/dify/certbot/www"

DIFY_VERSION="$(resolve_dify_version)"
if [ -z "$DIFY_VERSION" ]; then
  echo "Could not resolve the latest Dify release tag." >&2
  exit 1
fi
printf '%s\n' "$DIFY_VERSION" > "$DIFY_VERSION_FILE"

if [ ! -d "$DIFY_DIR/.git" ]; then
  git clone --depth 1 --branch "$DIFY_VERSION" https://github.com/langgenius/dify.git "$DIFY_DIR"
else
  current_tag="$(git -C "$DIFY_DIR" describe --tags --exact-match 2>/dev/null || true)"
  if [ "$current_tag" != "$DIFY_VERSION" ]; then
    git -C "$DIFY_DIR" fetch --depth 1 origin "refs/tags/${DIFY_VERSION}:refs/tags/${DIFY_VERSION}"
    git -C "$DIFY_DIR" checkout --detach "$DIFY_VERSION"
  fi
fi

if [ ! -f "$DIFY_DOCKER_DIR/.env" ]; then
  cp "$DIFY_DOCKER_DIR/.env.example" "$DIFY_DOCKER_DIR/.env"
fi

sandbox_source_conf="$DIFY_DOCKER_DIR/volumes/sandbox/conf"
sandbox_target_conf="$MEMORY_DATA_DIR/dify/sandbox/conf"
if [ -d "$sandbox_source_conf" ] && ! find "$sandbox_target_conf" -mindepth 1 -print -quit | grep -q .; then
  cp -R "$sandbox_source_conf/." "$sandbox_target_conf/"
fi

default_dify_secret="$(printf '%s%s' 'sk-' '9f73s3ljTXVcMT3Blb3ljTqtsKiGHXVcMT3BlbkFJLK7U')"
if grep -qx "SECRET_KEY=${default_dify_secret}" "$DIFY_DOCKER_DIR/.env"; then
  set_env "$DIFY_DOCKER_DIR/.env" SECRET_KEY "$(generate_secret)"
fi

set_env "$DIFY_DOCKER_DIR/.env" DB_TYPE "postgresql"
set_env "$DIFY_DOCKER_DIR/.env" VECTOR_STORE "weaviate"
set_env "$DIFY_DOCKER_DIR/.env" EXPOSE_NGINX_PORT "127.0.0.1:0"
set_env "$DIFY_DOCKER_DIR/.env" EXPOSE_NGINX_SSL_PORT "127.0.0.1:0"
set_env "$DIFY_DOCKER_DIR/.env" EXPOSE_PLUGIN_DEBUGGING_HOST "localhost"
set_env "$DIFY_DOCKER_DIR/.env" EXPOSE_PLUGIN_DEBUGGING_PORT "5003"

# Defensive: bootstrap.sh normally creates settings/.env, but a direct
# dify-bootstrap.sh run (without bootstrap) should still leave a usable env.
if [ ! -f "$MEMORY_ENV" ]; then
  mkdir -p "$MEMORY_SETTINGS_DIR"
  cp "$MEMORY_DIR/.env.example" "$MEMORY_ENV"
fi

echo "Dify ${DIFY_VERSION} is bootstrapped under $DIFY_DIR"
echo "Canonical memory env: $MEMORY_ENV"
