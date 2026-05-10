---
name: plan-capture
description: How plans flow into the project's `plans` dataset slot. Auto-capture happens on ExitPlanMode approval; agents may also save mid-iteration manually with save_to_dataset.
---

# Plan capture

Plans live in TWO places: the local plan-mode file (`~/.claude/plans/<slug>.md`, ephemeral, per-client, invisible to other agents) and the Dify `plans` dataset slot (durable, shared across every agent on this project). Only the Dify copy survives client restarts and is queryable by other sessions.

For the broader "save to memory / RAG vs local file" decision, see the routing table in [`self-improvement.md`](./self-improvement.md). This skill is the plans-specific contract.

> **Investigations have no auto-capture.** There is no `ExitInvestigationMode` tool, so investigation artefacts are NOT covered by any hook. Always use `save_to_dataset(dataset="investigations", name="<slug>.md", text, metadata)` manually.

## Auto-capture on ExitPlanMode approval

The boilerplate ships a `PostToolUse` hook (`scripts/hooks/exit-plan-mode.mjs`, invoked via the `exit-plan-mode.sh` wrapper) keyed on the `ExitPlanMode` matcher. When you exit plan mode and the user approves the plan (`tool_response.approved === true`), the hook:

1. Reads `tool_input.plan` (the plan markdown).
2. Extracts the title from the first H1 (or the first non-empty line, capped at 80 chars).
3. Slugifies the title and upserts `plan-<slug>.md` into the `plans` slot via the same upsert-by-name path `save_to_dataset` uses (create-or-replace by exact name, then a follow-up metadata write; the bridge does both internally as one MCP call).
4. Tags the doc with `atom_type=plan`, `task_type=planning`. (`project_module` is intentionally omitted, not set to `unknown`, so it doesn't pollute downstream metadata filters.)

Iterating on the SAME plan title overwrites the SAME Dify doc: no duplicates accumulate. The hook is silent on rejection (`approved !== true`), empty plans, an unbound `plans` slot, or a downed bridge.

You do NOT need to manually save approved plans. The hook handles it.

## When to save manually

Call `save_to_dataset(dataset="plans", name="plan-<slug>.md", text, metadata)` when:

- The plan stabilises mid-iteration and you want it queryable BEFORE the user approves it (so a sibling agent or your future self can find it).
- You are saving a stand-alone plan artefact OUTSIDE of plan mode (a roadmap, a release plan, a draft you want sharable).
- You want richer metadata than the auto-capture sets, e.g. `project_module="auth"` so `recall_lessons` / `search_memory` can filter by code area.

Use a stable, descriptive slug (`plan-auth-rewrite.md`, not `plan-1.md`). The slug IS the identity.

### Renaming and cleanup

If the plan TITLE changes between iterations, the next approval writes a NEW Dify doc under the new slug; the old slug stays. There is no MCP delete tool. Two options:

- **Tolerate it.** Old plans are ranked below the latest by recency (`upload_date`) and metadata, and `search_memory` with a tight `scoreThreshold` will surface the right one.
- **Clean up in the Dify UI.** Knowledge → `plans` dataset → delete the stale `plan-<old-slug>.md`.

To intentionally supersede a prior version with new content, write a NEW `save_to_dataset` call with the OLD slug and the new body. Same name overwrites.

## Hard rules

- The hook is gated on a 256KB plan-body cap (tunable via `MEMORY_HOOK_EXITPLANMODE_MAX_BYTES`). Bigger plans skip with `plan-too-large`. If you have a genuinely huge plan, split it or save manually with `save_to_dataset` after pre-truncating.
- Plan body is **redacted** for common secret shapes (API keys, JWTs, PEM blocks, DB connection URLs, Azure storage keys) before persisting. Do not rely on this as a security boundary; never paste production secrets into a plan.
- The persisted body is wrapped in a `<!-- BEGIN UNTRUSTED PLAN BODY ... -->` fence so future agents reading it via `recall_lessons` / `search_memory` see explicit data-vs-instructions boundaries (mitigates prompt-injection-via-memory).
- Set `MEMORY_HOOK_EXITPLANMODE_DISABLE=true` in `memory/.env` to disable the auto-capture entirely; the hook becomes a no-op.

## When NOT to save

- The user is still drafting or iterating: the auto-capture already gates on approval.
- The user rejected the plan: it's noise.
- You are saving a one-off thought or a fact, not a plan: use the `knowledge` slot instead (or let the flush + compile pipeline distil it on its own).

## How retrieval works

`search_memory({ query, datasets: ["plans"], filters: { atom_type: "plan" }, scoreThreshold: 0.55 })` retrieves plans by query + metadata filter. The doc-name prefix `plan-` is also a useful free-text signal in the embedding rank. If you set `project_module` on a manual save, you can scope further: `filters: { atom_type: "plan", project_module: "auth" }`.
