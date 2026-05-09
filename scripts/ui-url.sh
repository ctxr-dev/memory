#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

published="$(docker_compose port nginx 80 2>/dev/null | tail -n 1 || true)"

if [ -z "$published" ]; then
  echo "Dify UI port is not published yet. Start the stack with: $MEMORY_DIR/scripts/up.sh"
  exit 0
fi

port="${published##*:}"
echo "Dify UI: http://127.0.0.1:${port}"
