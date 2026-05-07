#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

load_memory_env

LEGACY_MEMORY_ROOT="$MEMORY_DIR/data/dify"
LEGACY_VENDOR_ROOT="$DIFY_DOCKER_DIR/volumes"
NEW_ROOT="$MEMORY_DATA_DIR/dify"

copy_dir_if_needed() {
  local old_path="$1"
  local new_path="$2"

  if [ ! -d "$old_path" ]; then
    return 0
  fi

  mkdir -p "$new_path"

  if find "$new_path" -mindepth 1 -print -quit | grep -q .; then
    echo "Keeping existing $new_path"
    return 0
  fi

  if find "$old_path" -mindepth 1 -print -quit | grep -q .; then
    echo "Migrating $old_path -> $new_path"
    ditto "$old_path" "$new_path"
  fi
}

copy_tree() {
  local source_root="$1"

  copy_dir_if_needed "$source_root/app/storage" "$NEW_ROOT/app/storage"
  copy_dir_if_needed "$source_root/db/data" "$NEW_ROOT/db/data"
  copy_dir_if_needed "$source_root/redis/data" "$NEW_ROOT/redis/data"
  copy_dir_if_needed "$source_root/sandbox/dependencies" "$NEW_ROOT/sandbox/dependencies"
  copy_dir_if_needed "$source_root/sandbox/conf" "$NEW_ROOT/sandbox/conf"
  copy_dir_if_needed "$source_root/plugin_daemon" "$NEW_ROOT/plugin_daemon"
  copy_dir_if_needed "$source_root/weaviate" "$NEW_ROOT/weaviate"
  copy_dir_if_needed "$source_root/certbot/conf" "$NEW_ROOT/certbot/conf"
  copy_dir_if_needed "$source_root/certbot/www" "$NEW_ROOT/certbot/www"
}

copy_tree "$LEGACY_MEMORY_ROOT"
copy_tree "$LEGACY_VENDOR_ROOT"

echo "Persistent data root: $NEW_ROOT"
