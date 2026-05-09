const PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]"],
  [/(api[_-]?key|secret|token|password)(["'\s:=]+)[^"'\s]+/gi, "$1$2[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]"],
  [/\bctx7sk-[A-Za-z0-9_-]{16,}\b/g, "ctx7sk-[REDACTED]"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "ghp_[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
];

export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const [re, repl] of PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}
