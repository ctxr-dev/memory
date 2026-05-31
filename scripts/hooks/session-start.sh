#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# Fire-confirmation breadcrumb (W18z): definitive answer to "did this
# hook actually run?" without depending on Claude Code's stderr capture,
# which is dropped/buffered in practice. The log is one line per
# invocation, monotonic, append-only, never read by the hook itself.
# Best-effort: any failure (read-only filesystem, missing parent dir)
# silently degrades to no log. Never blocks the hook.
LOG_DIR="${SCRIPT_DIR%/scripts/hooks}"
{ printf '%s %s invoked (CLAUDE_PROJECT_DIR=%s, pwd=%s)\n' \
    "$(date -u +%FT%T)" "$(basename "$0")" "${CLAUDE_PROJECT_DIR:-<unset>}" "$(pwd)" \
    >>"$LOG_DIR/.hook-runs.log"; } 2>/dev/null || true

node "$SCRIPT_DIR/session-start.mjs"
