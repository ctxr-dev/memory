# Workspace Agent Configuration

This workspace keeps agent-facing configuration under `.agents/` so Claude, Cursor, Codex/OpenAI, and other MCP-capable clients can share the same local memory definition.

- Canonical MCP config: `.agents/mcp.json`
- Per-server MCP snippet: `.agents/mcp/__MEMORY_SERVER_NAME__.mcp.json`
- Client snippets: `.agents/clients/`
- Vendor-neutral rules: `.agents/rules/` (always rendered by `bootstrap.sh`)
- Optional hook manifest: `.agents/hooks.json`, only installed with `--install-hooks`
- Optional Claude Code project hook adapter: `.claude/settings.json`, only installed with `--install-hooks`
- Optional Claude Code project skills: `.claude/skills/`, mirrored from `.agents/rules/` only when `--install-hooks`
- Runtime stack: `memory/`

`mcp.json` is the workspace-owned MCP source of truth. Clients that do not automatically read `.agents/mcp.json` can use the generated snippets in `.agents/clients/` or the helper:

```bash
./memory/scripts/mcp-config.sh all
```

Codex/OpenAI can be registered with:

```bash
codex mcp add __MEMORY_SERVER_NAME__ -- docker exec -i __MEMORY_SERVER_NAME__ node src/index.js
```

When hooks are installed, `hooks.json` is the workspace-owned hook source of truth. `.claude/settings.json` mirrors the same hooks so Claude Code can run them without extra setup. Other clients may not support Claude Code hook events, but they can still use the MCP tools. Do not put secrets in hooks. The memory MCP server gets its secrets from `memory/.env` inside Docker.

The optional Claude Code hooks cover `SessionStart`, `PreCompact`, `PostCompact`, and `SessionEnd`. The flush hooks (`PreCompact`, `PostCompact`, `SessionEnd`) call the configured LLM provider to extract typed atoms and write them as `daily-<ts>.md` documents to Dify (one document per flush event). The lazy compile stage (`scripts/compile.mjs`, triggered by `SessionStart` once per UTC day) reads those daily docs back from Dify, routes each atom by type to the right slot (lessons -> `self_improvement`, everything else -> `knowledge`), dedup-merges against existing entries with metadata-filtered candidates, and disables the source dailies. All memory lives in Dify; no local memory files are written.

Both `.agents/rules/self-improvement.md` and (when hooks are installed) `.claude/skills/self-improvement.md` carry the same skill contract: call `recall_lessons` before related work and `save_lesson` immediately when the user corrects you. Bootstrap re-renders both surfaces on every run from the canonical source under `templates/skills/`.

For Claude Desktop, Cursor, or another MCP client, merge the MCP server from `.agents/mcp.json` or `.agents/clients/` into the client's MCP configuration. The server intentionally uses the project-local Docker container name `__MEMORY_SERVER_NAME__`.
