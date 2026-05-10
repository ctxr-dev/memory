---
name: plan-capture
description: How plans flow into the project's `plans` dataset slot. Auto-capture happens on ExitPlanMode approval; agents may also save mid-iteration manually with save_to_dataset.
---

# Plan capture

Plans live in TWO places: the local plan-mode file (`~/.claude/plans/<slug>.md`, ephemeral, per-client, invisible to other agents) and the Dify `plans` dataset slot (durable, shared across every agent on this project). Only the Dify copy survives client restarts and is queryable by other sessions.

## Auto-capture on ExitPlanMode approval

The boilerplate ships a `PostToolUse` hook (`scripts/hooks/exit-plan-mode.sh`) keyed on the `ExitPlanMode` matcher. When you exit plan mode and the user approves the plan (`tool_response.approved === true`), the hook:

1. Reads `tool_input.plan` (the plan markdown).
2. Extracts the title from the first H1 (or the first non-empty line, capped at 80 chars).
3. Slugifies the title and writes `plan-<slug>.md` into the `plans` slot via `save_to_dataset` (upsert-by-name + metadata in one call).
4. Tags the doc with `atom_type=plan`, `task_type=planning`, `project_module=unknown`.

Iterating on the SAME plan title overwrites the SAME Dify doc: no duplicates accumulate. The hook is silent on rejection (`approved !== true`), empty plans, an unbound `plans` slot, or a downed bridge.

You do NOT need to manually save approved plans. The hook handles it.

## When to save manually

Call `save_to_dataset(dataset="plans", name="plan-<slug>.md", text, metadata)` when:

- The plan stabilises mid-iteration and you want it queryable BEFORE the user approves it (e.g. you want a sibling agent or your future self to find it).
- The plan title CHANGES between iterations and you want to supersede the previous version intentionally: call `save_to_dataset` with the OLD slug and an empty body, or rely on the auto-capture to write a new doc and clean up the old one yourself.
- You are saving a stand-alone plan artefact OUTSIDE of plan mode (e.g. a roadmap, a release plan).

Use a stable, descriptive slug (`plan-auth-rewrite.md`, not `plan-1.md`). The slug IS the identity.

## When NOT to save

- The user is still drafting or iterating: the auto-capture already gates on approval.
- The user rejected the plan: it's noise.
- You are saving a one-off thought, not a plan: use the `knowledge` slot instead.

## How retrieval works

`search_memory({ query, datasets: ["plans"], filters: { atom_type: "plan" }, scoreThreshold: 0.55 })` retrieves plans by query + metadata filter. The doc-name prefix `plan-` is also a useful free-text signal in the embedding rank.
