# Contributing

Thanks for reading. This is a personal-scale boilerplate. The process is light, but a few conventions matter.

By submitting a pull request you agree that your contribution is licensed under the project's [MIT license](LICENSE).

## Dev setup

Two contexts:

- **Working ON the boilerplate itself** (cloning this repo to develop the boilerplate): paths in this file are relative to the repo root (e.g. `./scripts/ps.sh`, `./bootstrap.sh`).
- **Working IN a project that installed the boilerplate** (`git clone https://github.com/ctxr-dev/memory ./memory`): same files live under `./memory/` (e.g. `./memory/scripts/ps.sh`).

```bash
# Working on the boilerplate itself:
git clone https://github.com/ctxr-dev/memory
cd memory
# Root has zero dependencies. The bridge has its own:
( cd mcp-server && npm install )
```

Tests use Node's built-in `node:test` runner: no dev-deps required at the root.

## Running tests

```bash
npm test
```

The full suite is hermetic (no Docker, no Dify) and runs in ~2s. Tests live under `test/*.test.mjs` (one file per module/area). New tests: add a sibling file matching the convention.

For the **write-path integration smoke** (requires a running bridge + a bound `plans` slot), use:

```bash
./scripts/plan-capture-smoke.sh           # writes + verifies + deletes a synthetic doc
./scripts/plan-capture-smoke.sh --keep    # leaves the smoke doc for visual inspection
```

## Static checks

```bash
bash -n bootstrap.sh scripts/*.sh scripts/hooks/*.sh
node --check scripts/compile.mjs scripts/hooks/*.mjs scripts/lib/*.mjs
node --check mcp-server/src/*.js
node --check test/*.test.mjs
```

CI runs the same on macOS (where bash 3.2 catches the portability issues we promise end-users) and Linux (Node 20 + 22).

**Windows note:** `npm test` on Windows requires Git Bash or WSL2. The `node --test test/*.test.mjs` glob does not expand under cmd.exe / PowerShell, so use one of those shells.

## Commit conventions

Conventional Commits with a scope:

```
feat(plan-capture): auto-capture approved plans to RAG via PostToolUse/ExitPlanMode
fix(hooks): TTY guard so manual debug runs don't hang on stdin
docs(readme): split atom-types table to avoid contradiction with prompts/flush.md
```

Scopes actually in use today: `plan-capture`, `hooks`, `memory`, `memory-boilerplate`. Suggested for new work: `bridge`, `dify`, `tests`, `docs`, `ci`, `security`, `deps`.

Multi-paragraph bodies are welcome for non-trivial commits: the `git log` of this branch is the de-facto changelog source.

## Branch naming

- `feat/<short-slug>` for new features.
- `fix/<short-slug>` for bug fixes.
- `docs/<short-slug>` for documentation-only changes.

## PR review process

The audit history of this branch (many rounds of parallel-reviewer fixups, currently round-27 and counting) is the working model for non-trivial changes:

1. **Land the change.** Include tests + docs in the same commit when possible.
2. **Spawn 2-3 parallel reviewers** for non-trivial changes (security / performance / docs / e2e). The Claude Code `Task` tool is the lightest path: launch general-purpose agents in parallel with a focused prompt each.
3. **Fix findings in a follow-up commit.** Tag with the same scope.
4. **Update `CHANGELOG.md`** (Added / Changed / Migration sections) before merging to `main`.

When the feature branch is ready to merge, expect to squash-merge: the per-round audit commits are useful history on the branch but noise on `main`. The CHANGELOG entry is the canonical history.

## Style notes

- **No mocks at integration boundaries.** Tests against the bridge use real `node --test` against pure helpers; integration coverage uses opt-in scripts (`mcp-smoke.sh`, `plan-capture-smoke.sh`) that talk to a real Dify.
- **No em dashes in Claude-authored runtime output** (skill prompts, CLI stderr, hook breadcrumbs). Use commas, colons, parentheses, line breaks. Markdown prose in this file uses normal punctuation.
- **Pure helpers preferred over hidden side effects.** New hook logic should split into a pure `*Spec()` function (testable) plus a thin CLI driver.
- **Cross-runtime parity** when the bridge and host share a constant (e.g. `slug.mjs` ↔ `slug.js`, `METADATA_SCHEMA` ↔ `PER_DOC_METADATA_FIELDS`): lock with a parity test in `test/`.

## Reporting bugs

Use [GitHub Issues](https://github.com/ctxr-dev/memory/issues). For installation issues, include:

- Output of `./scripts/ps.sh` (or `./memory/scripts/ps.sh` if you installed the boilerplate into a project).
- Output of `./scripts/ui-url.sh`.
- Output of `docker logs $MCP_CONTAINER_NAME --tail 50` (defaults to `<slug>-memory` if you accepted the bootstrap default).
- Your `bootstrap.sh` invocation (with the slug).
- The MCP client you're using (Claude Code, Cursor, Codex, etc.).

For security issues see [SECURITY.md](SECURITY.md): do **not** file public issues for those.
