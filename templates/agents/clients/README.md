# MCP Client Adapters

`.agents/` is the universal source of truth for this project's memory MCP server.

Use these generated snippets for clients that do not automatically read `.agents/mcp.json`:

- `generic-mcp.json`: generic JSON MCP config, also usable for Claude Desktop-style config.
- `claude-desktop.json`: Claude Desktop-compatible snippet.
- `cursor.json`: Cursor-compatible snippet.
- `openai-codex.toml`: Codex/OpenAI CLI config shape for `~/.codex/config.toml`.

The installed project also provides:

```bash
./.memory/src/scripts/mcp-config.sh all
./.memory/src/scripts/mcp-config.sh codex
./.memory/src/scripts/mcp-config.sh codex-toml
./.memory/src/scripts/mcp-config.sh claude-desktop
./.memory/src/scripts/mcp-config.sh cursor
```

Codex/OpenAI can usually be registered automatically with:

```bash
codex mcp add __MEMORY_SERVER_NAME__ -- docker exec -i __MEMORY_SERVER_NAME__ node src/index.js
```

If the installer was run with `--install-hooks`, Claude Code hooks are mirrored in `.claude/settings.json` because Claude Code has its own project settings file. Other clients may use the MCP tools but may not run Claude Code hook events.

The MCP bridge exposes **15 tools**: read (`search_memory`, `recall_lessons`, `get_memory_config`, `list_datasets`), write (`write_memory`, `update_memory`, `save_to_dataset`, `save_lesson`), dataset lifecycle (`create_dataset`, `delete_document`, `disable_document`, `enable_document`), audit (`audit_memory`), and absorb-flow (`scan_documents`, `absorb_files`). Tool discovery is automatic via MCP's `tools/list`; clients see the complete list once the server is registered.

Three skills are rendered into `.agents/rules/` (and into `.claude/skills/` when hooks are installed):

- `self-improvement.md`: how to call `recall_lessons` before related work and `save_lesson` immediately when the user corrects you. Routing decision tree for "save to memory" / "memorize" requests.
- `plan-capture.md`: how plans flow into the `plans` dataset slot. The `PostToolUse` / `ExitPlanMode` hook auto-captures approved plans (Claude Code interactive mode only as observed today); manual `save_to_dataset` covers other clients and headless runs. Cleanup via `audit_memory({classes: ["stale-plans"]})` to surface candidates, then `delete_document` (permanent) or `disable_document` (soft, reversible).
- `investigation-capture.md`: when and how to save a long debugging session as a durable artefact in the `investigations` slot. Agent-side rule (no hook), with a suggested body template and required-ish metadata guidance.
