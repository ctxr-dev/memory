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
# name trigger recreate. This avoids misclassifying option values whose
# text is NOT a service name (e.g. `--profile foo`, `--pull always`,
# `--project-name myapp`).
#
# Known limitation: if a flag's VALUE is spelled exactly like a real
# Compose service (e.g. `up.sh --project-name memory_mcp`), it is still
# treated as a service-name request and triggers --force-recreate. A
# fully robust fix would require knowing which `docker compose up` flags
# take a value (an open-ended, version-dependent list) and skipping those
# values — fragile enough that it would risk breaking legitimate
# positional usage like `up.sh --build memory_mcp`. The boilerplate only
# ever invokes this wrapper with a bare positional service name
# (`up.sh memory_mcp`), so the residual ambiguity is accepted rather than
# papered over with a brittle parser.
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

# Snapshot user settings (.env, .dify-version, embedding model) into
# ./.memory/settings/ so they survive removing/re-cloning ./memory.
# snapshot-settings.sh is best-effort (always exits 0, prints its own
# warnings), so call it unconditionally — a `|| echo` here would be dead
# code and a non-zero exit can't break this script.
"$SCRIPT_DIR/snapshot-settings.sh"
