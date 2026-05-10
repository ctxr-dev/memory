# Contributing

Thanks for reading. This is a personal-scale boilerplate, not a team-scale project, so the process is light — but a few conventions matter.

## Dev setup

```bash
git clone https://github.com/ctxr-dev/memory
cd memory
# Root has zero dependencies. The bridge has its own:
cd mcp-server && npm install && cd ..
```

Tests use Node's built-in `node:test` runner — no dev-deps required at the root.

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

## Commit conventions

Conventional Commits with a scope:

```
feat(plan-capture): auto-capture approved plans to RAG via PostToolUse/ExitPlanMode
fix(hooks): TTY guard so manual debug runs don't hang on stdin
docs(readme): split atom-types table to avoid contradiction with prompts/flush.md
```

Common scopes: `plan-capture`, `hooks`, `bridge`, `dify`, `tests`, `docs`, `ci`.

Multi-paragraph bodies are welcome for non-trivial commits — the `git log` of this branch is the de-facto changelog source.

## Branch naming

- `feat/<short-slug>` for new features.
- `fix/<short-slug>` for bug fixes.
- `docs/<short-slug>` for documentation-only changes.

## PR review process

The audit history of this branch (24+ rounds of parallel-reviewer fixups) is the working model for non-trivial changes:

1. **Land the change.** Include tests + docs in the same commit when possible.
2. **Spawn 2-3 parallel reviewers** for non-trivial changes (security / performance / docs / e2e). The agent harness in `.agents/` makes this cheap.
3. **Fix findings in a follow-up commit.** Tag with the same scope.
4. **Update `CHANGELOG.md`** (Added / Changed / Migration sections) before merging to `main`.

Squash-merge is the default for feature branches with many fixup commits; the CHANGELOG entry is the canonical history.

## Style notes

- **No mocks at integration boundaries.** Tests against the bridge use real `node --test` against pure helpers; integration coverage uses opt-in scripts (`mcp-smoke.sh`, `plan-capture-smoke.sh`) that talk to a real Dify.
- **No em dashes in Claude-authored text** on this project (use commas, colons, parentheses, line breaks). Human-authored content is exempt.
- **Pure helpers preferred over hidden side effects.** New hook logic should split into a pure `*Spec()` function (testable) plus a thin CLI driver.
- **Cross-runtime parity** when the bridge and host share a constant (e.g. `slug.mjs` ↔ `slug.js`, `METADATA_SCHEMA` ↔ `PER_DOC_METADATA_FIELDS`) — lock with a parity test in `test/`.

## Reporting bugs

Use [GitHub Issues](https://github.com/ctxr-dev/memory/issues). For installation issues, include:

- Output of `./memory/scripts/ps.sh`
- Output of `./memory/scripts/ui-url.sh`
- Output of `docker logs <slug>-memory --tail 50`
- Your `bootstrap.sh` invocation (with the slug)
- The MCP client you're using (Claude Code, Cursor, Codex, etc.)

For security issues see [SECURITY.md](SECURITY.md) — do **not** file public issues for those.
