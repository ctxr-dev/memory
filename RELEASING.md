# Releasing

How to cut a tagged release of this boilerplate. The agent stops at PR-ready
state; the human (maintainer) runs the steps below.

## Pre-tag verification

Verify on the PR head BEFORE squash-merging:

```bash
cd /path/to/memory   # the boilerplate working tree
npm test             # expect all green; count matches the CHANGELOG claim
bash -n bootstrap.sh scripts/*.sh scripts/hooks/*.sh
node --check scripts/compile.mjs scripts/hooks/*.mjs scripts/lib/*.mjs mcp-server/src/*.js test/*.test.mjs test/lib/*.mjs
```

Then verify against a live bridge (optional but recommended for any
release that touches the bridge surface):

```bash
./scripts/up.sh memory_mcp
./scripts/mcp-smoke.sh                  # read-path probes incl. audit_memory
./scripts/plan-capture-smoke.sh         # write-path probe
```

## Cutting the tag

1. **Squash-merge the feature PR** to `main`. Suggested squash-commit
   title for the v0.1.0 PR:
   ```
   feat: typed memory pipeline + plan-capture + audit tools (#2)
   ```
   The squash body should reference the CHANGELOG `[Unreleased]` block.

2. **Stamp the CHANGELOG.** On `main`:
   - Rename `## [Unreleased]` to `## [0.1.0] - YYYY-MM-DD` (UTC date).
   - Insert a fresh empty `## [Unreleased]` stub above the new entry so
     subsequent PRs have a place to land.
   - Commit with message `chore(release): stamp CHANGELOG for v0.1.0`.

3. **Tag.** Tags MUST be annotated (not lightweight) so `git describe`
   surfaces them and GitHub Release notes can pick them up cleanly:
   ```bash
   git tag -a v0.1.0 -m "v0.1.0 — typed memory pipeline + plan-capture + audit tools"
   git push origin v0.1.0
   ```

4. **GitHub Release.** Open `gh release create v0.1.0` (or via the
   Releases UI). Paste the `[0.1.0]` CHANGELOG entry as the release body.
   Mark as "latest" (the default for an annotated tag without `--prerelease`).

5. **Verify.** The README's release badge picks up the new tag
   automatically once GitHub indexes the release (usually within a
   minute). Check `https://github.com/ctxr-dev/memory/releases/latest`
   redirects to v0.1.0.

## Version pinning for downstream users

Downstream users who want stability over rolling can pin their install
to a tagged release:

```bash
git clone --branch v0.1.0 https://github.com/ctxr-dev/memory ./.memory/src
```

The default install instructions in the README track `main` (rolling).
Pinning is documented as opt-in.

## Hot-fix release

For a patch release (e.g. v0.1.1) targeting a critical bug found
post-tag:

1. Branch from the tag: `git checkout -b hotfix/v0.1.1 v0.1.0`.
2. Cherry-pick the fix commits from `main` (or commit directly if the
   fix is hotfix-only).
3. Open a PR to `main` so the fix lands on the rolling branch too.
4. After merge, repeat the "Cutting the tag" steps with the patch
   version bumped.

## Pre-release tags

For an alpha / beta cut (e.g. v0.2.0-rc.1), use the same flow but pass
`--prerelease` to `gh release create`. The release badge will continue
to show the latest STABLE release, not the prerelease.

## Backout

If a release needs to be retracted (e.g. accidentally tagged broken
HEAD):

1. Delete the GitHub release: `gh release delete v0.1.0`.
2. Delete the tag locally and remote:
   ```bash
   git tag -d v0.1.0
   git push origin --delete v0.1.0
   ```
3. Re-cut after fixing.

Do NOT amend or re-push the SAME tag pointing at a different commit.
Downstream users who already cloned the original tag would silently end
up on a different tree than every other user.
