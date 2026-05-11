#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

"$SCRIPT_DIR/dify-bootstrap.sh"

# When the user passes specific service names (e.g. `up.sh memory_mcp`),
# they're explicitly asking to recreate JUST that service to pick up
# env_file / image changes. Compose does NOT recreate a running container
# on env_file content change alone unless we pass --force-recreate, so
# the user-documented "restart the bridge to refresh env" recipe would
# otherwise silently no-op. The no-args case keeps default semantics so
# we don't churn the Postgres / Redis / Qdrant containers on every run.
if [ "$#" -gt 0 ]; then
  docker_compose up -d --build --force-recreate "$@"
else
  docker_compose up -d --build
fi
"$SCRIPT_DIR/ui-url.sh"
