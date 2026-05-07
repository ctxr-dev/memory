#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/lib.sh"

"$SCRIPT_DIR/bootstrap.sh"

docker_compose up -d --build "$@"
"$SCRIPT_DIR/ui-url.sh"
