#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

"$SCRIPT_DIR/dify-bootstrap.sh"

# When the user passes a SERVICE NAME (e.g. `up.sh memory_mcp`), they're
# explicitly asking to recreate JUST that service to pick up env_file /
# image changes. Compose does NOT recreate a running container on
# env_file content change alone unless we pass --force-recreate, so the
# user-documented "restart the bridge to refresh env" recipe would
# otherwise silently no-op. The no-args case (and flag-only cases like
# `up.sh --help`) keeps default semantics so we don't churn Postgres /
# Redis / Qdrant on every run.
#
# Service-name detection: only args that EXACTLY match a Compose service
# name trigger recreate. This avoids misclassifying option values (e.g.
# `--profile foo`, `--pull always`, `--project-name X`) as service names.
has_service_arg=0
services="$(docker_compose config --services 2>/dev/null || true)"
for arg in "$@"; do
  if printf '%s\n' "$services" | grep -Fx -- "$arg" >/dev/null; then
    has_service_arg=1
    break
  fi
done

if [ "$has_service_arg" -eq 1 ]; then
  docker_compose up -d --build --force-recreate "$@"
else
  docker_compose up -d --build "$@"
fi
"$SCRIPT_DIR/ui-url.sh"
