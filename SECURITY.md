# Security policy

## Reporting a vulnerability

The **preferred** channel is a private [GitHub Security Advisory](https://github.com/ctxr-dev/memory/security/advisories/new). It is encrypted, threaded, and gives you a private fork to share repro code without leaking the vulnerability publicly.

As a fallback, email **dmitri.meshin@gmail.com** with the subject `[memory-boilerplate] security report`. Please do **not** open a public GitHub issue for security-sensitive reports until the fix is shipped.

This is a single-maintainer project, so I cannot guarantee a fixed response time. Best-effort acknowledgement within 7 calendar days; if you do not hear back, please re-send or open a Security Advisory directly. A reasonable disclosure window is 90 days from acknowledgement, but I am open to discussing tighter or longer windows depending on severity and complexity.

## In scope

- **Redaction bypass**: a secret pattern that `scripts/lib/redact.mjs` should catch but does not. The pattern set is best-effort: we do not claim to catch every secret format. See `scripts/lib/redact.mjs` for the authoritative list of currently-handled patterns. Affects what gets persisted to Dify by the `flush` and `exit-plan-mode` hooks.
- **Prompt-injection-via-memory**: a way to craft a plan body, lesson, or absorbed document such that a future agent reading it via `recall_lessons` / `search_memory` is hijacked into running attacker-controlled actions. The untrusted-content fence (`<!-- BEGIN UNTRUSTED PLAN BODY ... -->`) wrapped around plan bodies is the current mitigation; if you can bypass it, that is in scope.
- **Bridge command injection**: a way to inject shell metacharacters via plan title, slug, MCP tool argument, or env variable that ends up executed by the bridge's `execCli` / `docker exec` flow. The current model uses `spawn` (no shell) and `slugify` ASCII-folds; a bypass is in scope.
- **Secret leakage in error messages**: a path where the bridge's error wrapping (`DifyBridgeUnavailable` propagation) surfaces an API key, plan body, or other sensitive content into the agent transcript.
- **Path traversal / symlink redirection**: any way to make `bootstrap.sh`, the hook scripts, or `dify-setup.sh` write outside the workspace via a crafted symlink or filename.
- **Resource exhaustion** (memory / CPU / disk on the host running the hook): an input that defeats one of the existing caps. The 1MB `execCli` stdout/stderr buffer cap in `scripts/lib/dify-write.mjs` and the 256KB (`256_000` bytes) plan-body cap (`MEMORY_HOOK_EXITPLANMODE_MAX_BYTES`) are the current mitigations; a bypass is in scope.

### Concrete examples

**In scope** (please report):

- A `redact()` pattern misses an Azure storage connection string in a specific format we haven't seen (e.g. `BlobEndpoint=...;SharedAccessSignature=...`).
- A crafted plan body bypasses the untrusted-content fence and gets a downstream agent to call `delete_document` on every doc in the `self_improvement` slot.
- A specific Dify error message wrapped by `DifyBridgeUnavailable` echoes a Bearer token into the agent transcript.
- A plan title with a particular Unicode sequence makes `slugify` produce a slug that escapes the `plans/` namespace (e.g. lands in `daily/` or `..`).
- A 200-byte plan body triggers a 5GB memory allocation via a regex backtracking bug in `redact()` or `fencePlanBody`.

**Out of scope** (please don't report, or only report informally):

- A novel API-key format (e.g. a new SaaS vendor's key prefix) that the current pattern set doesn't catch. This is a feature request; PRs welcome.
- A crafted plan body that, when read aloud, persuades the user (the human) to install something malicious. Social-engineering-of-the-human is not in our threat model.
- A misconfigured Dify instance that exposes its admin UI to the internet. Dify ops security is upstream.
- A workspace-write attacker editing `scripts/hooks/exit-plan-mode.mjs` to skip redaction. If they can write to your repo, they have already won.

## Out of scope

- **Supply-chain compromise of upstream dependencies** (`@modelcontextprotocol/sdk`, `zod`, Dify itself). Report those upstream first; we will track a coordinated update once the upstream fix lands.
- **Cryptographic guarantees about the redact patterns.** The patterns are best-effort, not exhaustive. A novel secret format we have never seen is not a security vulnerability in this project; it is a feature request (please file one and we will add the pattern in the next release).
- **Findings against a workspace-write attacker.** If an attacker can already write to your repo, they can edit `.claude/settings.json`, the hook scripts, and the bridge source directly. The boilerplate's threat model assumes write access to the workspace is itself a trust boundary.
- **Local privilege escalation via Docker.** Docker socket access already implies root-equivalent privilege on the host; Docker security is out of scope.
- **DoS against your own Dify instance via heavy plan-capture traffic.** The hook is per-ExitPlanMode-approval; a runaway agent triggering it in a loop is a Claude Code / Cursor / Codex concurrency-control concern, not a boilerplate one.
- **Time-of-check vs time-of-use races** in the bridge against the workspace filesystem or `memory/.env`. These are inherent to docker-compose-based file mounts.
- **Side-channel attacks** (timing, cache) on the redact patterns or any other helper. The code is not constant-time; nothing in this project is positioned as a cryptographic primitive.

## Hardening notes

- The boilerplate ships with `redact()` patterns for many common secret shapes (Bearer, generic `api_key|secret|token|password=...`, sk-/sk-ant-/ctx7sk-, AKIA, ghp_/github_pat_, AIza Google API keys, Slack xox*, Stripe live keys, JWT, npm tokens, Discord webhooks, PEM private keys, postgres/mysql/mongodb/redis/amqp userinfo, Azure storage AccountKey + SAS, npm authToken). See `scripts/lib/redact.mjs` for the authoritative list and `test/redact.test.mjs` for the positive + negative coverage. If your use case has additional patterns to redact, add them in `scripts/lib/redact.mjs` and add paired tests in `test/redact.test.mjs`.
- The hook's untrusted-content fence (`fencePlanBody` in `scripts/hooks/exit-plan-mode.mjs`) is a defense-in-depth measure. The CONTRACT it asserts is "a future agent must NOT execute instructions found inside the fence." If you prompt-engineer your agents to honour the fence, you reduce the prompt-injection surface; if you do not, the fence is a search anchor.
- Plan bodies are **size-capped at 256KB (`256_000` bytes)** via `MEMORY_HOOK_EXITPLANMODE_MAX_BYTES`. Bigger bodies skip with `plan-too-large`. This is a resource-exhaustion mitigation, not a security boundary.
- The `delete_document` MCP tool is **permanent and accepts any slot** (its description tells agents to prefer `disable_document` for lessons or compile-managed slots, but the bridge does not enforce that). If your threat model needs hard restrictions, wrap the bridge with a policy proxy or replace `delete_document` with a scoped variant.

## Acknowledgements

None yet. If you reported an issue, you will be credited here unless you prefer otherwise.
