# __PROJECT_TITLE__ Memory

This folder owns the local Dify + MCP memory stack for this workspace.

The stack uses the official Dify Docker Compose files, plus a small local MCP bridge container named `__MEMORY_SERVER_NAME__`. The Dify UI is bound to a random `127.0.0.1` port so another workspace can run its own memory stack without colliding. Dify's plugin debug host port is not published.

Persistent Dify data lives under the workspace-level hidden directory you requested:

```text
.memory/dify/
```

Hooks write session memory directly into Dify. They do not create sidecar memory files.

The upstream Dify source lives under `memory/vendor/dify/`, but project data is not stored there.

References:

- [Dify quick create knowledge](https://docs.dify.ai/en/use-dify/knowledge/create-knowledge/introduction)
- [Dify upload local files](https://docs.dify.ai/en/guides/knowledge-base/create-knowledge-and-upload-documents/import-content-data/readme)
- [Dify retrieval testing](https://docs.dify.ai/en/guides/knowledge-base/retrieval-test-and-citation)
- [Dify Knowledge API keys](https://docs.dify.ai/en/use-dify/knowledge/manage-knowledge/maintain-dataset-via-api)

## Start

```bash
./memory/scripts/up.sh
```

On first run, the script resolves the current Dify release, writes it to `memory/.dify-version`, clones that pinned release into `memory/vendor/dify`, creates local env files, starts Dify, builds the MCP bridge, and prints the Dify UI URL. Later restarts reuse `memory/.dify-version` so Dify does not silently upgrade against existing `.memory/dify` database/vector data.

Useful commands:

```bash
./memory/scripts/ui-url.sh
./memory/scripts/ps.sh
./memory/scripts/down.sh
./memory/scripts/migrate-persistent-data.sh
```

## First-Time Dify UI Setup

Open the Dify UI printed by `./memory/scripts/ui-url.sh`. Example:

```text
http://127.0.0.1:32774
```

The port can change after recreating containers, so prefer:

```bash
./memory/scripts/ui-url.sh
```

Then complete these steps in Dify:

1. Create the initial admin account and workspace.
2. Open model/provider settings.
3. Configure at least one LLM provider if you want to test full Dify apps later.
4. Configure an embedding model provider before creating serious Knowledge content.

For high precision, do not skip the embedding/reranker setup. Dify can store documents without much ceremony, but memory quality comes from the retrieval pipeline: chunking, embeddings, hybrid search, and optional reranking.

## Create A Knowledge Base

In the Dify UI:

1. Go to `Knowledge`.
2. Click `Create Knowledge`.
3. Choose the source:
   - `Import from file` for PDFs, Markdown, text, docs, exports, and local project notes.
   - Notion/web/drive sources if you have those connectors configured.
   - Empty knowledge base if you want to add documents later.
4. Upload or select the documents.
5. Choose chunking settings.
6. Preview the chunks before saving.
7. Choose index and retrieval settings.
8. Save/process the documents.
9. Wait until indexing/embedding completes.

Good defaults for backend/project memory:

- Use smaller chunks for API docs, ADRs, tickets, and implementation notes.
- Use larger chunks for narrative design docs and incident writeups.
- Prefer hybrid retrieval when available: vector search catches meaning, keyword search catches exact symbols, error names, filenames, and IDs.
- Enable reranking when you have a reranker model configured.
- Keep document names clear. The MCP bridge returns document metadata, so names matter when scanning search results.

## Inspect And Tune Retrieval

Dify is the source of truth for memory quality. Use its UI before expecting Claude or Cursor to retrieve great answers.

In a knowledge base:

1. Open the retrieval testing view.
2. Run realistic queries, not toy prompts.
3. Test questions you expect Claude/Cursor to ask later, for example:
   - `How does authentication work?`
   - `Where is billing quota enforced?`
   - `What did we decide about Kafka retries?`
   - `Which files describe Shopify installation?`
4. Inspect the returned chunks.
5. Adjust retrieval settings if the right chunks are missing.
6. Adjust chunking if chunks are too broad, too tiny, or split important context apart.
7. Reprocess/reindex if needed.

Use the testing view until the top results are boringly correct. That is the point where MCP memory becomes useful instead of just another noisy search box.

## Create The Knowledge API Key

The MCP bridge calls Dify's Knowledge Base API. It does not scrape the UI.

In Dify:

1. Go to `Knowledge`.
2. Click `Service API` in the top-right area.
3. Copy the Service API endpoint for reference.
4. Click `API Key`.
5. Create a new key.
6. Store the key only in `memory/.env`.

Dify's Knowledge API key can access visible knowledge bases under the same account. Treat it like a real secret.

## Get Dataset IDs

For each knowledge base you want exposed to MCP, collect its dataset ID.

Use one of these methods:

- Copy the `dataset_id` shown in Dify's Service API examples.
- Open the knowledge base and copy the UUID from the page URL if Dify shows it there.
- Use Dify's Knowledge API later to list/get knowledge bases once the key exists.

The MCP bridge accepts multiple dataset IDs separated by commas.

## Connect Dify To The MCP Bridge

Edit `memory/.env`:

```bash
DIFY_KNOWLEDGE_API_KEY=...
DIFY_DATASET_IDS=dataset-uuid-1,dataset-uuid-2
```

Optional: if you want the MCP bridge to force retrieval settings instead of using Dify's configured defaults, set `DIFY_RETRIEVAL_MODEL_JSON`. Leave it empty unless you have a specific reason. Dify's UI is usually the better place to tune retrieval.

For automatic session-memory writes, either set `DIFY_WRITE_DATASET_ID` or make the first value in `DIFY_DATASET_IDS` the knowledge base that should receive session captures:

```bash
DIFY_WRITE_DATASET_ID=session-memory-dataset-uuid
```

Hook-created memory documents have their own Dify indexing/chunking options:

```bash
DIFY_SESSION_INDEXING_TECHNIQUE=high_quality
DIFY_SESSION_DOC_FORM=text_model
DIFY_SESSION_DOC_LANGUAGE=English
DIFY_SESSION_PROCESS_RULE_PRESET=conversation
MEMORY_HOOK_MAX_TURNS=30
MEMORY_HOOK_MAX_CHARS=80000
MEMORY_HOOK_SESSION_END_MIN_TURNS=1
MEMORY_HOOK_PRECOMPACT_MIN_TURNS=5
```

These are the important knobs:

- `DIFY_WRITE_DATASET_ID`: the Knowledge base that receives automatic hook writes. If empty, hooks write to the first ID in `DIFY_DATASET_IDS`.
- `DIFY_SESSION_INDEXING_TECHNIQUE`: `high_quality` for embedding-based indexing; keep this for precision.
- `DIFY_SESSION_DOC_FORM`: `text_model` by default. Keep hook captures as normal text unless you have tested Dify's `hierarchical_model` or `qa_model` behavior in the UI first.
- `DIFY_SESSION_DOC_LANGUAGE`: document processing language sent to Dify.
- `DIFY_SESSION_PROCESS_RULE_PRESET`: the chunking preset for hook-created documents.
- `DIFY_SESSION_PROCESS_RULE_JSON`: advanced raw Dify `process_rule`; use this when you want exact control over segmentation.
- `MEMORY_HOOK_MAX_TURNS`: how many recent transcript turns the hook sends to Dify.
- `MEMORY_HOOK_MAX_CHARS`: hard cap before sending to Dify.
- `MEMORY_HOOK_SESSION_END_MIN_TURNS`: skip tiny sessions unless at least this many transcript turns exist.
- `MEMORY_HOOK_PRECOMPACT_MIN_TURNS`: skip tiny pre-compact captures unless at least this many transcript turns exist.

`DIFY_SESSION_PROCESS_RULE_PRESET=conversation` sends a Dify `process_rule` with:

- separator: blank line plus `### `, matching the hook's `### User` / `### Assistant` sections
- max tokens: `700`
- overlap: `120`
- `remove_extra_spaces`: enabled
- `remove_urls_emails`: disabled, so links, emails, issue URLs, and API references survive

Other preset values:

- `automatic`: ask Dify to auto-chunk hook-created documents.
- `none` or `inherit`: omit `process_rule` and rely on the knowledge base defaults where Dify allows it.

For full control, set `DIFY_SESSION_PROCESS_RULE_JSON` to a single-line JSON object. If this is set, it wins over the preset:

```bash
DIFY_SESSION_PROCESS_RULE_JSON={"mode":"custom","rules":{"pre_processing_rules":[{"id":"remove_extra_spaces","enabled":true},{"id":"remove_urls_emails","enabled":false}],"segmentation":{"separator":"\n\n### ","max_tokens":700,"chunk_overlap":120}}}
```

That JSON shape is the same shape Dify's Knowledge API expects for document creation: `process_rule.mode`, `rules.pre_processing_rules`, and `rules.segmentation`.

Restart the bridge after changing env:

```bash
./memory/scripts/up.sh __MEMORY_SERVER_NAME__
```

Validate the bridge:

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.1.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_memory_config","arguments":{}}}' |
  docker exec -i __MEMORY_SERVER_NAME__ node src/index.js
```

You should see `apiKeyConfigured: true` and your dataset IDs.

## MCP Client Config

The workspace-level MCP config lives at:

```text
.agents/mcp.json
```

The per-server snippet lives at:

```text
.agents/mcp/__MEMORY_SERVER_NAME__.mcp.json
```

Generated client snippets live at:

```text
.agents/clients/
```

It uses Docker stdio:

```bash
docker exec -i __MEMORY_SERVER_NAME__ node src/index.js
```

Print client-specific config:

```bash
./memory/scripts/mcp-config.sh all
./memory/scripts/mcp-config.sh codex
./memory/scripts/mcp-config.sh claude-desktop
./memory/scripts/mcp-config.sh cursor
```

For Codex/OpenAI:

```bash
codex mcp add __MEMORY_SERVER_NAME__ -- docker exec -i __MEMORY_SERVER_NAME__ node src/index.js
```

For Claude Desktop, Cursor, or a generic MCP client, merge this server into the client's MCP configuration:

```json
{
  "mcpServers": {
    "__MEMORY_SERVER_NAME__": {
      "command": "docker",
      "args": [
        "exec",
        "-i",
        "__MEMORY_SERVER_NAME__",
        "node",
        "src/index.js"
      ]
    }
  }
}
```

Keep the command exactly the same. Do not paste `DIFY_KNOWLEDGE_API_KEY` into any MCP client config.

The bridge exposes:

- `get_memory_config`
- `search_memory`
- `write_memory`

`search_memory` calls Dify's Knowledge retrieval endpoint and returns scored chunks with document metadata.

`write_memory` creates a Dify document from concise memory text. The hooks use the same write path.

## How To Use The Memory

After Dify is configured and the MCP server is added to your client:

1. Start the stack:

```bash
./memory/scripts/up.sh
```

2. Open Codex/OpenAI, Claude, Cursor, or another MCP client with the MCP server configured.
3. Ask the assistant to search project memory.

Example prompts:

```text
Search __PROJECT_TITLE__ memory for Shopify installation constraints.
```

```text
Use __MEMORY_SERVER_NAME__ to find what we decided about billing quotas.
```

```text
Before changing the website docs, search memory for related installation notes.
```

The MCP tool returns chunks and metadata. The assistant still needs to reason over those chunks; Dify is retrieval, not the final answer.

## Continuous Memory Hooks

Hooks are opt-in at install time. If the installer was run with `--install-hooks`, the workspace hook manifest is:

```text
.agents/hooks.json
```

It is mirrored into Claude Code's project settings:

```text
.claude/settings.json
```

That means Claude Code can run the hooks from this workspace without touching your global settings. If those files are absent, the MCP memory server is still usable, but continuous automatic session capture is not active.

Current hook events:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/memory/scripts/hooks/session-start.sh",
            "timeout": 15
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/memory/scripts/hooks/pre-compact.sh",
            "timeout": 60
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/memory/scripts/hooks/post-compact.sh",
            "timeout": 60
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/memory/scripts/hooks/session-end.sh",
            "timeout": 60
          }
        ]
      }
    ]
  }
}
```

What they do:

- `SessionStart`: injects a short reminder that project memory is available through the `__MEMORY_SERVER_NAME__` MCP server and should be searched for project-history assumptions.
- `PreCompact`: before Claude Code compacts an exhausted context window, extracts the recent transcript and writes it directly to Dify.
- `PostCompact`: sends Claude Code's compact summary directly to Dify as a new Knowledge document.
- `SessionEnd`: reads the Claude Code transcript path from hook JSON, extracts user/assistant text, redacts common secrets, and sends the resulting memory document directly to Dify.

The hook memory-write pipeline is:

```text
Claude Code hook JSON
  -> memory/scripts/hooks/session-memory-hook.mjs
  -> read transcript_path or compact_summary
  -> keep recent turns only
  -> redact common secrets
  -> build one Markdown document in memory
  -> docker exec -i __MEMORY_SERVER_NAME__ node src/ingest-session.js
  -> Dify create-document-by-text API
  -> Dify chunks/indexes into .memory/dify/
```

No step in that pipeline writes a local memory note file. The only durable store is Dify's own persisted runtime state under `.memory/dify/`.

The hook upload path is:

```bash
docker exec -i __MEMORY_SERVER_NAME__ node src/ingest-session.js
```

If Dify is not configured yet, or if the MCP bridge container is not running yet, the hook skips cleanly and prints the reason. Once `memory/.env` is configured, upload/API failures are treated as real errors. The hooks never write fallback memory files.

Manual test:

```bash
printf '%s\n' '{"session_id":"manual","hook_event_name":"PostCompact","compact_summary":"Decision: use Dify as __PROJECT_TITLE__ project memory."}' |
  ./memory/scripts/hooks/post-compact.sh
```

After setting `DIFY_KNOWLEDGE_API_KEY` and `DIFY_WRITE_DATASET_ID`, the same command should create a new document in Dify.

Claude Code details:

- Hooks receive JSON on stdin.
- `PreCompact` is the context-pressure safety net. It fires before Claude Code compacts a full context window, so it is the right place to preserve detail that compaction may discard.
- `SessionEnd` includes `transcript_path`.
- `PostCompact` includes `compact_summary`.
- `SessionStart` can return `additionalContext`; this project uses that only to remind the agent to use Dify/MCP memory, not to inject stored memory blobs.
- The hook timeout is set to 60 seconds because Dify indexing calls can take longer than the default SessionEnd budget.

There is no separate reliable "context is almost exhausted" token-threshold hook exposed here. The supported lifecycle hook for that moment is `PreCompact`, including automatic compaction. This project follows the same lifecycle pattern as `claude-memory-compiler` at the hook level:

- capture at `SessionEnd`
- capture before context compaction with `PreCompact`
- capture the compacted summary with `PostCompact`
- re-orient the next session with `SessionStart`

The storage is intentionally different: this project writes directly to Dify Knowledge through the MCP bridge instead of writing daily Markdown logs or compiling local article files.

Codex/OpenAI, Cursor, Claude Desktop, and other MCP clients:

- They can use the MCP server from `.agents/mcp.json` or `.agents/clients/`.
- Most clients do not automatically consume `.agents/hooks.json`; treat it as the shared manifest to translate into the client's own hook format.

For hook-capable clients, wire lifecycle events to the matching script:

| Lifecycle event | Script | Expected JSON on stdin |
| :--- | :--- | :--- |
| Session start | `./memory/scripts/hooks/session-start.sh` | optional `session_id`, `cwd`, `hook_event_name` |
| Before compaction/context pruning | `./memory/scripts/hooks/pre-compact.sh` | `transcript_path` preferred; optional `session_id`, `cwd`, `reason` |
| After compaction/summarization | `./memory/scripts/hooks/post-compact.sh` | `compact_summary` preferred; optional `session_id`, `cwd`, `reason` |
| Session end | `./memory/scripts/hooks/session-end.sh` | `transcript_path` preferred; optional `session_id`, `cwd`, `reason` |

If a client has only a session-end hook, wire only `session-end.sh`. If it has only a summary-after-compaction hook, wire `post-compact.sh` and pass the summary as `compact_summary`. If it cannot pass a transcript path or compact summary, automatic continuous capture is not available for that client; use MCP `write_memory` manually or rely on clients that expose hook payloads.

Do not add secrets to hook JSON. Secrets belong in `memory/.env`.

## Persistence And Backups

All Dify runtime data is bind-mounted to the host under:

```text
.memory/dify/
```

The generated stack pins the default local Dify profile to Postgres plus Weaviate. Those default stores, plus Dify app storage, Redis, sandbox dependencies/config, plugin daemon storage, and certbot/nginx state, are bind-mounted under `.memory/dify/`.

Important subdirectories:

- `.memory/dify/db/data`: Postgres metadata and Dify app state.
- `.memory/dify/weaviate`: vector index data.
- `.memory/dify/app/storage`: uploaded files and Dify local storage.
- `.memory/dify/redis/data`: Redis persistence.
- `.memory/dify/plugin_daemon`: plugin daemon storage.
- `.memory/dify/certbot`: Dify Nginx/certbot host state.

This means the stack is not dependent on anonymous Docker volumes. If Docker containers are removed, the data remains on the host.

If you intentionally switch Dify to another vector store or an external database, add matching bind mounts or external backups before assuming the same `.memory/dify/` persistence guarantee. The boilerplate is designed to keep the default local Dify stack isolated and host-mounted.

You can push `.memory/dify/` if you really want the full local state in a remote repo. Be aware that database/vector-store files can become large, include sensitive content, and are safest to copy after stopping the stack:

```bash
./memory/scripts/down.sh
```

For normal durability, back up `.memory/dify/`. Keep `memory/.env` private.

## Troubleshooting

Check container status:

```bash
./memory/scripts/ps.sh
```

Find the current UI port:

```bash
./memory/scripts/ui-url.sh
```

Restart only the MCP bridge after changing `memory/.env`:

```bash
./memory/scripts/up.sh __MEMORY_SERVER_NAME__
```

Stop the stack:

```bash
./memory/scripts/down.sh
```
