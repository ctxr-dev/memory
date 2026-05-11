---
name: self-improvement
description: Use the project memory to look up self-improvement lessons before related work, persist new lessons the moment the user corrects you, and route every "save to memory" / "memorize" request to the RAG store instead of any client-local memory system.
---

# Memory routing — RAG is the default when healthy

> When the user says **"save to memory", "memorize this", "remember that", "save it for later"**, or any equivalent, the project's RAG memory MCP server is the **DEFAULT** destination — as long as it is registered and healthy.
>
> **Why default to RAG:** local-file memory (Claude Code's `~/.claude/projects/.../memory/*.md`, Cursor's project memory, etc.) is per-client and per-session: invisible to every other agent and to your future self in another session. The RAG memory is shared across every agent on this project, persists in Dify, and is the entire reason the boilerplate exists. Picking local-file memory when RAG is available silently bypasses it and gives the user the impression nothing was actually saved where it counts.
>
> **Health probe:** treat the RAG path as healthy if a `save_to_dataset` / `save_lesson` call succeeds. If it errors (bridge container down, no datasets bound, network unreachable), the RAG path is unhealthy.
>
> **Decision:**
>
> 1. **RAG healthy** → use one of the MCP tools below (decision tree). Do NOT also write to local memory; that creates two sources of truth.
> 2. **RAG unhealthy or unregistered** → fall back to your client's local file-based memory and tell the user in one short line that you did so (e.g., "saved to local memory, RAG bridge is down"). Don't refuse to save just because the cloud side is dead — the user's intent matters more than where it lands.
>
> Routing decision tree (when RAG is healthy):
>
> | What you're saving | Tool | Slot |
> |---|---|---|
> | Behavioural lesson about the AI (correction, repeated mistake, rule) | `save_lesson` | `self_improvement` (auto) |
> | Project fact / decision / lore / convention | `save_to_dataset` | `knowledge` |
> | Plan or investigation as a durable artefact | `save_to_dataset` | `plans` or `investigations` |
> | Reusable code-level pattern / library footgun | `save_to_dataset` | `knowledge` (atom_type=pattern-gotcha) |
>
> All `save_to_dataset` calls use upsert-by-name semantics: same `name` overwrites, no duplicates.
>
> **Plans-specific note:** approved plans (via `ExitPlanMode`) are auto-captured by a `PostToolUse` hook into the `plans` slot — see [`plan-capture.md`](./plan-capture.md). Do NOT also call `save_to_dataset` for an approved plan; the hook handles it. Manual `save_to_dataset` is for mid-iteration plans, investigations, and stand-alone artefacts.

# Self-improvement memory (the lesson loop)

This project ships with a Dify-backed self-improvement loop. Two MCP tools matter:

- `recall_lessons` — search lessons before starting a task
- `save_lesson` — persist a lesson the instant the user corrects you

## Before any non-trivial task

Call `recall_lessons` with the task context you can infer from the user's request and the files involved:

```
recall_lessons({
  query: "<short description of what you are about to do>",
  project_module: "<auth | billing | infra | frontend | cli | ...>",
  language: "<swift | python | typescript | bash | ... or omit>",
  task_type: "<planning | implementation | debugging | refactor | review | deploy | docs>",
  error_pattern: "<short kebab-case slug if you suspect a known trap, otherwise omit>"
})
```

Apply any returned lesson silently. Do not paraphrase it back to the user; just do the right thing. If you intentionally apply a recalled lesson, add one short line to your reply: `applied lesson: <lesson title>`. That signal lets the user see the loop is working without ceremony.

If `recall_lessons` returns nothing, do not stall — proceed normally. Absence of a recorded lesson is fine.

## When the user corrects you

Trigger conditions:
- Direct correction: "no", "stop doing X", "you should have done Y", reverting your work, "wrong".
- Repeat correction: "I told you before", "again", "same mistake", "we've covered this".
- Wrong-tool / wrong-step: the user pointed out you used the wrong file, command, format, or skipped a step.

The instant you observe one, call `save_lesson` BEFORE replying:

```
save_lesson({
  title: "<imperative summary, ≤80 chars: what to do (or not do) next time>",
  body: "<≤500 chars: lead with the rule, then 'Why:' and 'How to apply:' lines>",
  metadata: {
    project_module: "<inferred>",
    task_type: "<inferred>",
    error_pattern: "<short kebab-case slug naming the trap>",
    language: "<optional>"
  },
  tags: ["<scope>", "<area>"],
  evidence: "<one-line excerpt of the user's correction, redact secrets>"
})
```

`error_pattern` is the dedup key. Pick a short kebab-case slug that captures the FAILURE MODE, not the surface symptom. Examples:
- `missing-await-on-async-call`
- `bsd-sed-no-arg`
- `pr-comment-on-stale-head`
- `wrong-test-import-path`

If a future session corrects you on the same trap, the next compile pass will MERGE your new lesson into the existing one (same `error_pattern`), not multiply it.

## Do NOT save a lesson when

- The user is just clarifying or redirecting (`"actually let's switch to X"`).
- The user changed their mind about scope.
- The user blames themselves (`"oh wait, I gave you the wrong file"`).
- The user is exploring or thinking out loud.

## Hard rules

- Always set `error_pattern` for `save_lesson`. Without it, dedup fails and the lesson rots in isolation.
- Never paste secrets into `body`, `evidence`, or any field. The pipeline redacts common secrets, but do not test it.
- Do not call `save_lesson` and `recall_lessons` in the same turn for the same incident; recall first, save second.
- Do not enumerate every lesson back to the user. They asked you to do work, not narrate.
