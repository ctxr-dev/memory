# __PROJECT_TITLE__ Memory

This folder owns the local Dify + MCP memory stack for this workspace.

The stack uses the official Dify Docker Compose files, plus a small local MCP bridge container named `__MEMORY_SERVER_NAME__`. The Dify UI is bound to a random `127.0.0.1` port so another workspace can run its own memory stack without colliding. Dify's plugin debug host port is not published.

Persistent Dify data lives under the workspace-level hidden directory you requested:

```text
.memory/dify/
```

Hooks write session memory directly into Dify. They do not create sidecar memory files.

The upstream Dify source lives under `.memory/src/vendor/dify/`, but project data is not stored there.

References:

- [Dify quick create knowledge](https://docs.dify.ai/en/use-dify/knowledge/create-knowledge/introduction)
- [Dify upload local files](https://docs.dify.ai/en/guides/knowledge-base/create-knowledge-and-upload-documents/import-content-data/readme)
- [Dify retrieval testing](https://docs.dify.ai/en/guides/knowledge-base/retrieval-test-and-citation)
- [Dify Knowledge API keys](https://docs.dify.ai/en/use-dify/knowledge/manage-knowledge/maintain-dataset-via-api)

## Start

```bash
./.memory/src/scripts/up.sh
```

On first run, the script resolves the current Dify release, writes it to `./.memory/settings/.dify-version`, clones that pinned release into `.memory/src/vendor/dify`, creates local env files, starts Dify, builds the MCP bridge, and prints the Dify UI URL. Later restarts reuse `./.memory/settings/.dify-version` so Dify does not silently upgrade against existing `.memory/dify` database/vector data.

Useful commands:

```bash
./.memory/src/scripts/ui-url.sh
./.memory/src/scripts/ps.sh
./.memory/src/scripts/down.sh
./.memory/src/scripts/migrate-persistent-data.sh
```

## First-Time Dify UI Setup

Open the Dify UI printed by `./.memory/src/scripts/ui-url.sh`. Example:

```text
http://127.0.0.1:32774
```

The port can change after recreating containers, so prefer:

```bash
./.memory/src/scripts/ui-url.sh
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
6. Store the key only in `./.memory/settings/.env`.

Dify's Knowledge API key can access visible knowledge bases under the same account. Treat it like a real secret.

## Get Dataset IDs

For each knowledge base you want exposed to MCP, collect its dataset ID.

Use one of these methods:

- Copy the `dataset_id` shown in Dify's Service API examples.
- Open the knowledge base and copy the UUID from the page URL if Dify shows it there.
- Use Dify's Knowledge API later to list/get knowledge bases once the key exists.

The MCP bridge accepts multiple dataset IDs separated by commas.

## Connect Dify To The MCP Bridge

The recommended path is the wizard:

```bash
./.memory/src/scripts/dify-setup.sh
```

It binds named slots to Dify dataset IDs in `./.memory/settings/.env` and optionally absorbs your existing project documentation. See the [README onboarding section](README.md#onboarding) for the full walkthrough.

If you prefer to edit `./.memory/settings/.env` by hand, the relevant block is:

```bash
DIFY_KNOWLEDGE_API_KEY=...

# Each line declares one slot. The slot NAME is the env-var name
# lowercased between DIFY_DATASET_ and _ID. Empty value = declared but
# not bound yet.
DIFY_DATASET_DAILY_ID=...
DIFY_DATASET_KNOWLEDGE_ID=...
DIFY_DATASET_PLANS_ID=...
DIFY_DATASET_INVESTIGATIONS_ID=...
DIFY_DATASET_SELF_IMPROVEMENT_ID=...

DIFY_FLUSH_DATASET=daily
DIFY_COMPILE_DATASET=knowledge
DIFY_ABSORB_DEFAULT_DATASET=knowledge
```

Add more slots by adding a new `DIFY_DATASET_<NAME>_ID=` line, then re-run `dify-setup.sh` (it only asks about new/unbound slots). Auto-created datasets default to `high_quality` indexing + `hybrid_search` retrieval (full-text + vector).

Optional: if you want the MCP bridge to force retrieval settings instead of using Dify's configured defaults, set `DIFY_RETRIEVAL_MODEL_JSON`. Leave it empty unless you have a specific reason. Dify's UI is usually the better place to tune retrieval.

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

- `DIFY_DATASET_<NAME>_ID`: every line is one slot binding. Empty value = declared but unbound. `dify-setup.sh` maintains the file.
- `DIFY_FLUSH_DATASET` / `DIFY_COMPILE_DATASET` / `DIFY_ABSORB_DEFAULT_DATASET`: pipeline routing (slot names).
- `DIFY_SESSION_INDEXING_TECHNIQUE`: `high_quality` for embedding-based indexing; keep this for precision.
- `DIFY_SESSION_DOC_FORM`: `text_model` by default. Keep hook captures as normal text unless you have tested Dify's `hierarchical_model` or `qa_model` behavior in the UI first.
- `DIFY_SESSION_DOC_LANGUAGE`: document processing language sent to Dify.
- `DIFY_SESSION_PROCESS_RULE_PRESET`: the chunking preset for hook-created documents.
- `DIFY_SESSION_PROCESS_RULE_JSON`: advanced raw Dify `process_rule`; use this when you want exact control over segmentation.
- `MEMORY_HOOK_MAX_TURNS`: how many recent transcript turns flush.mjs hands to the LLM extractor.
- `MEMORY_HOOK_MAX_CHARS`: hard cap before sending to the LLM.
- `MEMORY_HOOK_SESSION_END_MIN_TURNS`: skip tiny sessions unless at least this many transcript turns exist.
- `MEMORY_HOOK_PRECOMPACT_MIN_TURNS`: skip tiny pre-compact captures unless at least this many transcript turns exist.
- `MEMORY_LLM_PROVIDER`: which LLM does flush + compile. See `.env.example`.
- `MEMORY_COMPILE_SEARCH_LIMIT`: how many top knowledge candidates compile considers per atom (default 5).

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
./.memory/src/scripts/up.sh memory_mcp
```

(`memory_mcp` is the compose service name; `__MEMORY_SERVER_NAME__` is the container name and is NOT a valid argument to `docker compose up`.)

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
./.memory/src/scripts/mcp-config.sh all
./.memory/src/scripts/mcp-config.sh codex
./.memory/src/scripts/mcp-config.sh claude-desktop
./.memory/src/scripts/mcp-config.sh cursor
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

The bridge exposes fifteen MCP tools (full descriptions in [README MCP tools table](README.md#mcp-tools)):

| Tool | Purpose |
|---|---|
| `search_memory` | Retrieve scored chunks; supports `filters` + `scoreThreshold` for Dify-side metadata filtering. |
| `recall_lessons` | "Look before you leap" recall of self-improvement lessons by task context, with broadening fall-back. |
| `get_memory_config` | Inspect bridge configuration (no secrets). |
| `write_memory` | Create-or-supersede a single document (low-level). |
| `update_memory` | Required-supersedes variant; used by compile. |
| `save_to_dataset` | Upsert by exact name into a named slot, optional `metadata` map. |
| `save_lesson` | Inline self-improvement-lesson capture; required `metadata.error_pattern` is the dedup key. |
| `list_datasets` | Show Dify datasets + local slot bindings. |
| `create_dataset` | Create a new Dify dataset; auto-installs the per-document metadata schema. |
| `delete_document` | Permanent delete of a doc by id. Use to retract a stale `plan-<old-slug>.md` after a title change, or any auto-captured / absorbed doc. |
| `disable_document` | Soft delete: hide from search but keep in Dify UI for audit. Use to retract a captured plan or lesson without losing the historical record. |
| `enable_document` | Reverse a `disable_document`: bring a previously hidden doc back into search results. |
| `audit_memory` | List-only walk of `plans`, `knowledge`, `self_improvement` slots; surfaces stale-plans, missing-metadata, stale-project-lore, duplicate-error-pattern findings. Act via the delete/disable tools. |
| `scan_documents` | Walk the workspace mount; return matches + suggested doc names. |
| `absorb_files` | Read selected files; upsert each into the chosen dataset. |

## How To Use The Memory

After Dify is configured and the MCP server is added to your client:

1. Start the stack:

```bash
./.memory/src/scripts/up.sh
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

The full memory pipeline (flush + compile, atom shape, dedup-merge) is documented in the repo [README](README.md). This section covers only the Dify-stack-relevant pieces: the manifest, the script-to-event mapping for non-Claude clients, and the manual-test commands.

Hooks are opt-in at install time. If `bootstrap.sh --install-hooks` was used (default on), the workspace hook manifest is:

```text
.agents/hooks.json
```

It is mirrored into Claude Code's project settings:

```text
.claude/settings.json
```

That means Claude Code can run the hooks from this workspace without touching your global settings. If those files are absent, the MCP memory server is still usable, but continuous automatic session capture is not active.

**Re-runs are non-destructive.** `bootstrap.sh` invokes `scripts/merge-config.mjs` (pure Node, no `jq`) to structurally merge the rendered `hooks.json` and `settings.json` into the user's existing files. The boilerplate identifies its own entries by the literal command signature `"$CLAUDE_PROJECT_DIR"/.memory/src/scripts/hooks/...`; any hook entry that does NOT carry that signature is preserved verbatim across re-runs. The same merge strategy applies to `.agents/mcp.json` (only the bridge server entry is replaced; other MCP servers in the user's config are untouched). See `scripts/lib/merge-config.mjs` for the contract; `test/merge-config.test.mjs` locks idempotency, isolation, and the anchored-signature guarantee.

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
            "command": "\"$CLAUDE_PROJECT_DIR\"/.memory/src/scripts/hooks/session-start.sh",
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
            "command": "\"$CLAUDE_PROJECT_DIR\"/.memory/src/scripts/hooks/pre-compact.sh",
            "timeout": 130
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
            "command": "\"$CLAUDE_PROJECT_DIR\"/.memory/src/scripts/hooks/post-compact.sh",
            "timeout": 130
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
            "command": "\"$CLAUDE_PROJECT_DIR\"/.memory/src/scripts/hooks/session-end.sh",
            "timeout": 130
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "\"$CLAUDE_PROJECT_DIR\"/.memory/src/scripts/hooks/exit-plan-mode.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

What they do (deeper detail in [README](README.md#how-memory-is-built)):

- `SessionStart`: emits an `additionalContext` reminder. Lazily spawns `scripts/compile.mjs` once per UTC day to dedup-merge any unprocessed daily logs into Dify in the background.
- `PreCompact` / `PostCompact` / `SessionEnd`: invoke `scripts/hooks/flush.mjs`. Flush calls the configured LLM provider with `prompts/flush.md` to extract typed atoms and writes them as ONE `daily-<YYYY-MM-DD-HHMMSSmmm>.md` document to Dify per event. The lazy compile pass later routes each atom by `atom_type` to the right slot — `self-improvement-lesson` atoms become `lesson-<slug>-<YYYY-MM-DD-HHMMSSmmm>.md` documents in the `self_improvement` dataset; everything else becomes `knowledge-<slug>-<YYYY-MM-DD-HHMMSSmmm>.md` in the `knowledge` dataset. Source dailies are disabled after their atoms are promoted.
- `PostToolUse` (matcher `ExitPlanMode`): when the user approves a plan, `scripts/hooks/exit-plan-mode.mjs` upserts `plan-<slug>.md` into the `plans` slot (deterministic, no LLM, several bridge round-trips: find + create + metadata + re-list + dedupe-delete; 30s timeout). Skips cleanly (exit 0) with a stderr message on rejection, empty plan body, unbound `plans` slot, or bridge failure. See [README → Saving plans](README.md#saving-plans-investigations-or-other-artefacts-manually) and the [`plan-capture` skill](templates/skills/plan-capture.md) for the agent-facing contract.

If the LLM provider is unavailable, the MCP bridge container is down, or `./.memory/settings/.env` is missing required keys, hooks skip cleanly with a stderr message and exit 0. They never block your session and never write fallback files.

Manual flush test (extracts and writes a `daily-<ts>.md` document to Dify if your LLM provider is configured and the bridge is up):

```bash
printf '%s\n' '{"session_id":"manual","hook_event_name":"PostCompact","compact_summary":"Decision: use Dify as __PROJECT_TITLE__ project memory because flat markdown does not scale."}' |
  ./.memory/src/scripts/hooks/post-compact.sh
# Find the doc in the Dify UI under your write dataset:
#   daily-2026-05-09-120530123.md
```

Manual compile (after `./.memory/settings/.env` is configured and the stack is up):

```bash
node ./.memory/src/scripts/compile.mjs              # promote any enabled daily-* docs
node ./.memory/src/scripts/compile.mjs --dry-run    # see decisions without writing to Dify
node ./.memory/src/scripts/compile.mjs --force      # also re-process disabled daily-* docs
                                               # (recovery pass; useful after a failed run)
```

The once-per-day gate lives in `scripts/hooks/session-start.mjs` (it short-circuits when `.compile-state.json:last_attempted_date` is today). Running compile manually always proceeds.

Claude Code hook details:

- Hooks receive JSON on stdin.
- `PreCompact` is the context-pressure safety net. It fires before Claude Code compacts a full context window, including automatic compaction.
- `SessionEnd` and `PreCompact` payloads include `transcript_path`; `PostCompact` includes `compact_summary`. Flush handles both shapes.
- `SessionStart` returns `additionalContext` only to remind the agent that memory exists. It does NOT inject stored memory blobs (that is the agent's job via `search_memory`).
- Hook timeouts: 130s for the flush hooks (PreCompact / PostCompact / SessionEnd), 30s for PostToolUse/ExitPlanMode (no LLM, but several bridge round-trips for find + create + metadata + re-list + dedupe-delete), and 15s for SessionStart. The LLM extraction call dominates wall-clock time on the flush path; 130s gives the default 120s LLM timeout headroom for spawn + parse.

This boilerplate follows the same lifecycle shape as [`coleam00/claude-memory-compiler`](https://github.com/coleam00/claude-memory-compiler) (capture at SessionEnd / PreCompact, summary at PostCompact, re-orient at SessionStart) and adds:

- A typed-atom output schema instead of free-form summary bullets.
- A dedup-merge compile stage that supersedes outdated entries instead of accumulating duplicates.
- A swappable LLM provider (Claude Code CLI / Codex CLI / Anthropic / OpenAI), so the boilerplate is not Claude-only.
- Dify Knowledge as the durable store instead of flat markdown article files.

Codex/OpenAI, Cursor, Claude Desktop, and other MCP clients:

- They can use the MCP server from `.agents/mcp.json` or `.agents/clients/`.
- Most clients do not automatically consume `.agents/hooks.json`; treat it as the shared manifest to translate into the client's own hook format.

For hook-capable clients, wire lifecycle events to the matching script:

| Lifecycle event | Script | Expected JSON on stdin |
| :--- | :--- | :--- |
| Session start | `./.memory/src/scripts/hooks/session-start.sh` | optional `session_id`, `cwd`, `hook_event_name` |
| Before compaction/context pruning | `./.memory/src/scripts/hooks/pre-compact.sh` | `transcript_path` preferred; optional `session_id`, `cwd`, `reason` |
| After compaction/summarization | `./.memory/src/scripts/hooks/post-compact.sh` | `compact_summary` preferred; optional `session_id`, `cwd`, `reason` |
| Session end | `./.memory/src/scripts/hooks/session-end.sh` | `transcript_path` preferred; optional `session_id`, `cwd`, `reason` |
| After ExitPlanMode tool returns approved | `./.memory/src/scripts/hooks/exit-plan-mode.sh` | `tool_input.plan` (string), `tool_response.approved` (true/false/null); optional `session_id`, `cwd`, `tool_name="ExitPlanMode"` |

If a client has only a session-end hook, wire only `session-end.sh`. If it has only a summary-after-compaction hook, wire `post-compact.sh` and pass the summary as `compact_summary`. If it cannot pass a transcript path or compact summary, automatic continuous capture is not available for that client; use MCP `write_memory` manually or rely on clients that expose hook payloads.

Do not add secrets to hook JSON. Secrets belong in `./.memory/settings/.env`.

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
./.memory/src/scripts/down.sh
```

For normal durability, back up `.memory/dify/`. Keep `./.memory/settings/.env` private.

## Troubleshooting

Check container status:

```bash
./.memory/src/scripts/ps.sh
```

Find the current UI port:

```bash
./.memory/src/scripts/ui-url.sh
```

Restart only the MCP bridge after changing `./.memory/settings/.env`:

```bash
./.memory/src/scripts/up.sh memory_mcp
```

Stop the stack:

```bash
./.memory/src/scripts/down.sh
```

### "FATAL: WORKSPACE_DIR resolves to '...' which is your home or root."

`scripts/lib.sh` refuses to run when the boilerplate was cloned at the user-project root (`git clone … .`) instead of into a `./.memory/src` subdirectory. Bind-mounting `$HOME` (or `/`) into the bridge container at `/workspace` would expose every dotfile and personal artefact to absorb / scan. The guard normalises both `$HOME` and `WORKSPACE_DIR` via `pwd -P`, so a Linux home that happens to be a symlinked mount also trips it. Fix: re-clone into a project subdirectory:

```bash
cd ~/your-project
git clone https://github.com/ctxr-dev/memory ./.memory/src
./.memory/src/bootstrap.sh --slug <project-slug>
```

### Concurrent compile attempts

`scripts/compile.mjs` acquires `.memory/src/.compile.lock` (file-based, atomic POSIX `O_CREAT|O_EXCL`) before mutating `.compile-state.json`. A second compile spawned by an overlapping `SessionStart` finds the lock alive and exits 0 silently. Stale locks (process dead, or holder older than `MEMORY_COMPILE_LOCK_STALE_MS`, default 30 minutes) are reclaimed automatically. Implementation: `scripts/lib/lock.mjs`. Manual recovery (only needed if a compile crashed mid-write AND the stale window has not elapsed):

```bash
rm -f .memory/src/.compile.lock
```
