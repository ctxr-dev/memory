const PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/(api[_-]?key|secret|token|password)(["'\s:=]+)[^"'\s]+/gi, "$1$2[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]"],
  [/\bctx7sk-[A-Za-z0-9_-]{16,}\b/g, "ctx7sk-[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  // Slack tokens (xoxb/xoxa/xoxp/xoxr/xoxs)
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "xox-[REDACTED]"],
  // Google API keys (fixed prefix + 35 b64url chars)
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "AIza[REDACTED]"],
  // Stripe live keys
  [/\b(sk|pk|rk)_live_[A-Za-z0-9]{16,}\b/g, "$1_live_[REDACTED]"],
  // Generic JWT (3 base64url segments separated by .)
  [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "eyJ[REDACTED-JWT]"],
];

export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const [re, repl] of PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}
