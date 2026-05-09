// Each pattern in scripts/lib/redact.mjs PATTERNS array gets a positive
// test (matches and is replaced) and a negative test (innocent text is
// NOT redacted). If you add a pattern, add a paired test here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { redact } from "../scripts/lib/redact.mjs";

test("redact: non-string passthrough", () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(42), 42);
  assert.deepEqual(redact({ a: 1 }), { a: 1 });
});

test("redact: empty string", () => {
  assert.equal(redact(""), "");
});

// Bearer tokens
test("redact: Bearer <token>", () => {
  const out = redact("Authorization: Bearer abc123.def_token-XYZ/=+");
  assert.ok(out.includes("Bearer [REDACTED]"));
  assert.ok(!out.includes("abc123.def_token-XYZ"));
});

test("redact: 'Bearer' followed by no whitespace+token is untouched", () => {
  // Pattern requires \s+ after Bearer; no following whitespace -> no match.
  assert.equal(redact("Bearer."), "Bearer.");
  assert.equal(redact("Bearer\n"), "Bearer\n");
  // The redactor errs on the side of false positives — "Bearer X" where X is
  // any token-shaped word IS redacted. Document that with a lock test so
  // future tightening of the pattern is intentional.
  const out = redact("The Bearer of bad news");
  assert.ok(out.startsWith("The Bearer [REDACTED]"));
});

// Generic key=value (api_key, secret, token, password)
test("redact: api_key=value", () => {
  const out = redact("api_key=supersecretvalue");
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(!out.includes("supersecretvalue"));
});

test("redact: api-key: value", () => {
  const out = redact('api-key: "hunter2hunter2"');
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(!out.includes("hunter2hunter2"));
});

test("redact: password=value", () => {
  const out = redact("password=letmein123");
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(!out.includes("letmein123"));
});

test("redact: token: 'abc'", () => {
  const out = redact("token: 'abc.def.ghi'");
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(!out.includes("abc.def.ghi"));
});

test("redact: keyword without a following value-shaped token is untouched", () => {
  // The keyword must be followed by ["'\s:=]+ then a non-quote/non-space
  // value. An end-of-string or punctuation-only suffix doesn't match.
  assert.equal(redact("the secret"), "the secret");
  assert.equal(redact("password!"), "password!");
  // Document the over-matching behaviour: "secret garden" IS redacted
  // because \s+ counts as the separator and "garden" is the value. This is
  // intentional — false positives are safer than leaking secrets.
  const out = redact("the secret garden");
  assert.ok(out.includes("[REDACTED]"));
});

// sk- (OpenAI-style)
test("redact: sk-xxx tokens", () => {
  const out = redact("OPENAI=sk-AbCdEf1234567890XyZ");
  assert.ok(out.includes("sk-[REDACTED]"));
  assert.ok(!out.includes("sk-AbCdEf1234567890XyZ"));
});

test("redact: short sk- prefix is NOT redacted (under 16 chars)", () => {
  assert.equal(redact("sk-short"), "sk-short");
});

// ctx7sk- (Context7-style)
test("redact: ctx7sk-xxx tokens", () => {
  const out = redact("key=ctx7sk-AbCdEf1234567890XyZ");
  assert.ok(out.includes("ctx7sk-[REDACTED]"));
  assert.ok(!out.includes("ctx7sk-AbCdEf1234567890XyZ"));
});

test("redact: short ctx7sk- is NOT redacted", () => {
  assert.equal(redact("ctx7sk-short"), "ctx7sk-short");
});

// GitHub PAT (ghp_)
test("redact: ghp_ tokens", () => {
  // Avoid the generic "token:" prefix, which would match first and replace
  // the whole tail with [REDACTED] before the ghp_ rule runs. We assert the
  // ghp_-specific rule on a context the generic pattern won't catch.
  const out = redact("see ghp_AbCdEf1234567890XYZAB in logs");
  assert.ok(out.includes("ghp_[REDACTED]"), `unexpected: ${out}`);
  assert.ok(!out.includes("ghp_AbCdEf1234567890XYZAB"));
});

test("redact: ghp_ too short -> NOT redacted", () => {
  assert.equal(redact("ghp_short"), "ghp_short");
});

// GitHub fine-grained PAT
test("redact: github_pat_ tokens", () => {
  const out = redact("github_pat_AbCdEf1234567890_xyz");
  assert.ok(out.includes("github_pat_[REDACTED]"));
  assert.ok(!out.includes("github_pat_AbCdEf1234567890_xyz"));
});

test("redact: github_pat_ too short -> NOT redacted", () => {
  assert.equal(redact("github_pat_short"), "github_pat_short");
});

// AWS access key
test("redact: AKIA AWS access key", () => {
  const out = redact("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
  assert.ok(out.includes("AKIA[REDACTED]"));
  assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("redact: AKIA prefix without 16 chars is NOT redacted", () => {
  assert.equal(redact("AKIASHORT"), "AKIASHORT");
});

test("redact: innocent prose is untouched", () => {
  const text = "The user opened a pull request describing a regression in the GitHub UI.";
  assert.equal(redact(text), text);
});

test("redact: idempotent (running twice does not double-redact)", () => {
  const once = redact("api_key=hunter2hunter2");
  const twice = redact(once);
  assert.equal(twice, once);
});

test("redact: multiple secrets in one string", () => {
  const out = redact("Bearer abc.def_token-X token=hunter2 sk-AbCdEf1234567890XYZ");
  assert.ok(out.includes("Bearer [REDACTED]"));
  assert.ok(out.includes("sk-[REDACTED]"));
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(!out.includes("hunter2"));
});
