# Changelog

All notable user-visible changes to this boilerplate. Dates use UTC.

## [Unreleased] — feat/typed-memory-pipeline

### Added

- **`PostToolUse` / `ExitPlanMode` auto-capture hook.** When the user approves a plan, `scripts/hooks/exit-plan-mode.mjs` upserts `plan-<slug>.md` into the `plans` Dify dataset slot. Deterministic, no LLM, multiple bridge round-trips. Body is redacted for common secret shapes and wrapped in an untrusted-content fence (`<!-- BEGIN UNTRUSTED PLAN BODY ... -->`) so future agents reading via `recall_lessons` / `search_memory` see explicit data-vs-instructions boundaries (mitigates prompt-injection-via-memory). Same plan title overwrites the same Dify doc; no duplicates accumulate.
- **`plan-capture` skill** at `templates/skills/plan-capture.md` rendered into both `.claude/skills/` and `.agents/rules/`. Documents the auto-capture contract, when to save manually, the verification path (stderr breadcrumb + Dify UI walkthrough), and hard rules (size cap, redaction, fence, kill switch, non-Latin-title collision).
- **`plan` atom_type** added to `scripts/lib/datasets.mjs:ATOM_TYPES` and routed to the `plans` slot. Set ONLY by the auto-capture hook (or by manual `save_to_dataset`); the flush extractor is explicitly forbidden from producing this type (`prompts/flush.md`).
- **`delete_document`, `disable_document`, and `enable_document` MCP tools.** Surface the bridge's delete/disable/enable primitives so agents can clean up stale `plan-<slug>.md` (or any other doc) without dropping into the Dify UI. `delete_document` is permanent (description warns about lessons / compile-managed slots); `disable_document` hides from search but keeps the audit trail; `enable_document` reverses a soft delete. Closes the create-without-undo asymmetry the auto-capture would otherwise leave open.
- **`create_dataset` MCP tool now auto-installs the per-document metadata schema** (`atom_type`, `tags`, `project_module`, `language`, `task_type`, `error_pattern`). Returns `metadataSchema.complete: boolean` so callers can detect partial installs. Pre-existing datasets created via the OLD `create_dataset` need a `dify-setup.sh` re-run for retro-installation.
- **Two new env knobs in `.env.example`**:
  - `MEMORY_HOOK_EXITPLANMODE_DISABLE=true` (case-sensitive) — disables the auto-capture entirely; the hook becomes a no-op.
  - `MEMORY_HOOK_EXITPLANMODE_MAX_BYTES=256000` — plan-body size cap; bigger bodies skip with `plan-too-large`.
- **`saveDocument` helper** in `scripts/lib/dify-write.mjs` wraps the bridge's existing `save` subcommand (upsert-by-name + metadata in one CLI call). `buildSaveFlags` exported for unit testing.
- **`slotEnvKey()` helper** in `scripts/lib/env.mjs` — single source of truth for computing `DIFY_DATASET_<NAME>_ID` env-var names from a slot string. Used by both `flush.mjs` and `exit-plan-mode.mjs`.
- **`mcp-server/src/schema.js`** — exports `PER_DOC_METADATA_FIELDS` so the parity test in `test/datasets.test.mjs` can lock host-side `METADATA_SCHEMA` against the bridge-side list via direct imports (no regex source parsing).

### Changed

- **`upsertDocumentByName` now re-lists at delete time** and removes every same-name doc except the freshly created one. Closes the concurrent-write race window: two parallel upserts no longer leave one orphan doc behind. Worst case settles to one doc with the latest body. **Behavior change**: any historical duplicates with the same name are silently merged on the next upsert.
- **`execCli` in `scripts/lib/dify-write.mjs`**:
  - Default timeout bumped 60s → 180s (a Dify create-by-text on a multi-KB plan body queues behind embedding; 60s was too tight).
  - stdout/stderr capped at 1MB each; overflow kills the child and rejects with a clear message (was unbounded — OOM vector).
  - SIGTERM/SIGINT handler propagates the kill to the docker exec child so a parent killed by Claude Code's outer hook timeout no longer leaks orphaned `docker exec` clients.
- **`redact()` now covers** Anthropic `sk-ant-`, DB connection URLs (`postgres://`, `postgresql://`, `mysql://`, `mongodb://`, `mongodb+srv://`, `redis://`, `rediss://`, `amqp://` — userinfo only, leaves routing visible), Azure storage `AccountKey=`, Azure SAS `sig=`, npm `_authToken=`. Each gets a positive + negative + idempotency test.
- **`create_dataset` MCP tool `ok` field semantics**: `ok = !!datasetId` (primary op success); separate `metadataSchema.complete` boolean for schema completeness. Was conflating the two; a caller seeing `ok:false` could mistakenly conclude no dataset existed.
- **README atoms tables split** into two: "Atoms extracted by flush+compile" (7 types) and "Atoms set by hooks" (1 type, `plan`). Removes the contradiction-by-skim where a reader could think the flush extractor produces plan atoms.
- **README "Updates" section** gained a 4-point "Upgrading to plan-capture" callout: re-run `dify-setup.sh` to retro-install schema, optional new env knobs, behavior change in `upsertDocumentByName`, MCP-client restart needed for hook-file changes.
- **README mermaid diagram** updated to show the `PostToolUse / ExitPlanMode → exit-plan-mode.mjs → plans` capture path; previously only manual `save_to_dataset` reaching plans was visible.
- **`prompts/flush.md`** explicitly forbids emitting `type: "plan"`; `flush.mjs:validateAtoms` enforces it with a stderr breadcrumb.
- **Hook log prefix** is now `exit-plan-mode.mjs:` (was `exit-plan-mode:`) for parity with `flush.mjs:`, `compile.mjs:`, `session-start.mjs:`.

### Migration

- **Re-run `./memory/scripts/dify-setup.sh` after `git pull`.** The wizard's `install_metadata_schema` step is idempotent: it inspects every bound slot, only installs missing fields, and silently skips ones already present. Without this, the new ExitPlanMode hook will succeed in writing plans but log `metadata warning: no fields matched dataset metadata schema` on every save until the wizard runs.
- The new env knobs in `.env.example` are NOT auto-merged into your existing `memory/.env` (re-runs preserve user edits). Copy them manually if you want to tune.
- **Recreate the bridge container** to pick up env changes after editing `memory/.env`: `./memory/scripts/up.sh memory_mcp`. The bridge reads `memory/.env` only at container start time, so any new `MEMORY_HOOK_EXITPLANMODE_*` knob you added is invisible until the container restarts.
- MCP-client restart needed for hook-file changes (`.claude/settings.json`, `.agents/hooks.json`) to take effect. Already-running Claude Code / Cursor / Codex sessions won't fire the new hook until restart.

### Tests

- Tests went from 156 (pre-feature) → 230 (after round-24) → 228 (after round-25, net of two over-locking `extractTitle` tests trimmed during round-25 maintainability cleanup). New test files: `test/exit-plan-mode.test.mjs`, `test/exit-plan-mode-cli.test.mjs`, `test/dify-write.test.mjs`, `test/env.test.mjs`. Existing files extended: `test/datasets.test.mjs` (schema parity), `test/redact.test.mjs` (new patterns), `test/merge-config.test.mjs` (matcher-collision regression for the new PostToolUse entry).
- New integration smoke `scripts/plan-capture-smoke.sh` exercises the create + metadata + dedupe-delete write path end-to-end against a running bridge. Skips with a clear message when the bridge or `plans` slot is not configured. Designed for opt-in use during install verification (write-path coverage gap that `mcp-smoke.sh` intentionally skips).

---

For prior history, see the Git log on the `feat/typed-memory-pipeline` branch.
