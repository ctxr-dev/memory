---
name: self-improvement
description: Use the project memory to look up self-improvement lessons before related work, and persist new lessons the moment the user corrects you.
---

# Self-improvement memory

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
