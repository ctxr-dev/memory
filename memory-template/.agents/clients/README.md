# MCP Client Adapters

`.agents/` is the universal source of truth for this project's memory MCP server.

Use these generated snippets for clients that do not automatically read `.agents/mcp.json`:

- `generic-mcp.json`: generic JSON MCP config, also usable for Claude Desktop-style config.
- `claude-desktop.json`: Claude Desktop-compatible snippet.
- `cursor.json`: Cursor-compatible snippet.
- `openai-codex.toml`: Codex/OpenAI CLI config shape for `~/.codex/config.toml`.

The installed project also provides:

```bash
./memory/scripts/mcp-config.sh all
./memory/scripts/mcp-config.sh codex
./memory/scripts/mcp-config.sh json
```

Codex/OpenAI can usually be registered automatically with:

```bash
codex mcp add __MEMORY_SERVER_NAME__ -- docker exec -i __MEMORY_SERVER_NAME__ node src/index.js
```

If the installer was run with `--install-hooks`, Claude Code hooks are mirrored in `.claude/settings.json` because Claude Code has its own project settings file. Other clients may use the MCP tools but may not run Claude Code hook events.
