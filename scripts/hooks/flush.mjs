import fs from "node:fs";
import path from "node:path";
import { DAILY_DIR, PROMPTS_DIR, envInt } from "../lib/env.mjs";
import { redact } from "../lib/redact.mjs";
import { callLLMWithRetry, LLMProviderUnavailable, LLMOutputInvalid } from "../lib/llm.mjs";

class SkipMemory extends Error {}

const mode = process.argv[2] || "session-end";
const VALID_MODES = new Set(["pre-compact", "post-compact", "session-end"]);
if (!VALID_MODES.has(mode)) {
  console.error(`flush.mjs: unknown mode '${mode}'`);
  process.exit(1);
}

const MAX_TURNS = envInt("MEMORY_HOOK_MAX_TURNS", 30);
const MAX_CHARS = envInt("MEMORY_HOOK_MAX_CHARS", 80_000);
const SESSION_END_MIN_TURNS = envInt("MEMORY_HOOK_SESSION_END_MIN_TURNS", 1);
const PRECOMPACT_MIN_TURNS = envInt("MEMORY_HOOK_PRECOMPACT_MIN_TURNS", 5);

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractTextBlocks(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => extractTextBlocks(v, depth + 1));
  if (typeof value !== "object") return [];
  if (value.type === "tool_use" || value.type === "tool_result") return [];
  if (typeof value.text === "string") return [value.text];
  return ["message", "content", "prompt", "compact_summary", "summary"]
    .flatMap((field) => extractTextBlocks(value[field], depth + 1));
}

function transcriptToMarkdown(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { markdown: "", turnCount: 0 };
  }
  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
  const blocks = [];
  for (const line of lines) {
    const entry = parseJsonMaybe(line);
    if (!entry) continue;
    const role = entry.message?.role || entry.role || entry.type || "entry";
    if (!["user", "assistant", "summary", "system"].includes(role)) continue;
    const text = extractTextBlocks(entry).join("\n").trim();
    if (!text) continue;
    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role;
    blocks.push(`### ${label}\n\n${text}`);
  }
  const recent = blocks.slice(-MAX_TURNS);
  return { markdown: recent.join("\n\n"), turnCount: recent.length };
}

function sliceForLLM(text) {
  if (text.length <= MAX_CHARS) return text;
  return `${text.slice(-MAX_CHARS)}\n\n[Truncated to last ${MAX_CHARS} chars by flush.mjs.]`;
}

function buildSourceMaterial(rawInput) {
  const hookInput = parseJsonMaybe(rawInput) || {};
  const sessionId = hookInput.session_id || "manual";
  const cwd = hookInput.cwd || process.cwd();
  const hookEvent = hookInput.hook_event_name || mode;
  const transcriptPath = hookInput.transcript_path || "";

  let body;
  let turnCount;
  if (hookInput.compact_summary) {
    body = `## Compact Summary\n\n${hookInput.compact_summary}`;
    turnCount = 1;
  } else if (transcriptPath) {
    const transcript = transcriptToMarkdown(transcriptPath);
    body = transcript.markdown;
    turnCount = transcript.turnCount;
  } else {
    body = "";
    turnCount = 0;
  }

  body = redact(body).trim();

  const minTurns = mode === "pre-compact" ? PRECOMPACT_MIN_TURNS : SESSION_END_MIN_TURNS;
  if (mode !== "post-compact" && turnCount < minTurns) {
    throw new SkipMemory(`only ${turnCount} transcript turns; minimum for ${mode} is ${minTurns}`);
  }
  if (!body) {
    throw new SkipMemory(`no usable transcript content for ${mode}`);
  }

  return {
    sessionId,
    cwd,
    hookEvent,
    body: sliceForLLM(body),
    turnCount,
  };
}

function loadPrompt() {
  const file = path.join(PROMPTS_DIR, "flush.md");
  if (!fs.existsSync(file)) {
    throw new Error(`flush prompt missing at ${file}`);
  }
  return fs.readFileSync(file, "utf8");
}

const ATOM_TYPES = new Set([
  "decision",
  "bug-root-cause",
  "feedback-rule",
  "project-lore",
  "reference",
  "pattern-gotcha",
]);

function validateAtoms(parsed, sessionId, hookEvent) {
  if (!parsed || !Array.isArray(parsed.atoms)) {
    throw new LLMOutputInvalid("LLM JSON missing 'atoms' array", JSON.stringify(parsed));
  }
  const cleaned = [];
  for (const atom of parsed.atoms) {
    if (!atom || typeof atom !== "object") continue;
    const type = String(atom.type || "").toLowerCase();
    const title = String(atom.title || "").trim();
    const body = String(atom.body || "").trim();
    if (!ATOM_TYPES.has(type) || !title || !body) continue;
    const tags = Array.isArray(atom.tags)
      ? atom.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
      : [];
    if (tags.length === 0) continue;
    cleaned.push({
      type,
      title: title.slice(0, 80),
      body: body.slice(0, 500),
      tags,
      evidence: atom.evidence ? String(atom.evidence).slice(0, 240).trim() : undefined,
      sessionId,
      hookEvent,
    });
  }
  return cleaned;
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowHms() {
  const d = new Date();
  return d.toISOString().slice(11, 19);
}

function ensureDailyHeader(file, dateStr) {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, `# Daily flush log ${dateStr}\n\n`);
}

function appendAtoms(atoms) {
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  const dateStr = todayUtcDate();
  const file = path.join(DAILY_DIR, `${dateStr}.md`);
  ensureDailyHeader(file, dateStr);

  const blocks = atoms.map((atom) => {
    const sid = String(atom.sessionId || "").slice(0, 8);
    const lines = [
      `### Atom (${nowHms()} · ${sid} · ${atom.hookEvent})`,
      `- type: ${atom.type}`,
      `- title: ${atom.title}`,
      `- tags: [${atom.tags.join(", ")}]`,
      `- body: |`,
      ...atom.body.split(/\r?\n/).map((line) => `    ${line}`),
    ];
    if (atom.evidence) {
      lines.push(`- evidence: ${JSON.stringify(atom.evidence)}`);
    }
    return lines.join("\n");
  });

  fs.appendFileSync(file, `${blocks.join("\n\n")}\n\n`);
  return file;
}

async function main() {
  const rawInput = readStdin();
  const source = buildSourceMaterial(rawInput);
  const systemPrompt = loadPrompt();

  let parsed;
  try {
    parsed = await callLLMWithRetry({
      systemPrompt,
      userPrompt: `Hook event: ${source.hookEvent}\nSession id: ${source.sessionId}\nCwd: ${source.cwd}\n\n--- TRANSCRIPT ---\n\n${source.body}`,
      maxTokens: 1500,
    });
  } catch (err) {
    if (err instanceof LLMProviderUnavailable) {
      throw new SkipMemory(`LLM provider unavailable: ${err.message}`);
    }
    if (err instanceof LLMOutputInvalid) {
      throw new SkipMemory(`LLM output invalid after retry: ${err.message}`);
    }
    throw err;
  }

  const atoms = validateAtoms(parsed, source.sessionId, source.hookEvent);
  if (atoms.length === 0) {
    throw new SkipMemory("LLM returned no usable atoms (transcript not durable)");
  }

  const file = appendAtoms(atoms);
  console.error(`flush.mjs: wrote ${atoms.length} atom(s) to ${file}`);
}

try {
  await main();
} catch (err) {
  if (err instanceof SkipMemory) {
    console.error(`flush.mjs: skipped (${mode}): ${err.message}`);
    process.exit(0);
  }
  console.error(`flush.mjs: failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
