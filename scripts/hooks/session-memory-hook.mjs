import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const mode = args[0] || "session-end";
const scriptPath = new URL(import.meta.url).pathname;
const memoryDir = path.resolve(path.dirname(scriptPath), "../..");
const envPath = path.join(memoryDir, ".env");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const env = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }

  return env;
}

const fileEnv = parseEnvFile(envPath);

function intFromEnv(name, fallback) {
  const raw = process.env[name] || fileEnv[name] || "";
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const maxTurns = intFromEnv("MEMORY_HOOK_MAX_TURNS", 30);
const maxChars = intFromEnv("MEMORY_HOOK_MAX_CHARS", 80_000);
const sessionEndMinTurns = intFromEnv("MEMORY_HOOK_SESSION_END_MIN_TURNS", 1);
const preCompactMinTurns = intFromEnv("MEMORY_HOOK_PRECOMPACT_MIN_TURNS", 5);

class SkipMemory extends Error {}

function redact(text) {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|secret|token|password)(["'\s:=]+)[^"'\s]+/gi, "$1$2[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-[REDACTED]")
    .replace(/\bctx7sk-[A-Za-z0-9_-]{16,}\b/g, "ctx7sk-[REDACTED]");
}

function parseJsonMaybe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractContent(value, depth = 0) {
  if (depth > 8 || value == null) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractContent(item, depth + 1));
  }

  if (typeof value !== "object") {
    return [];
  }

  if (value.type === "tool_use" || value.type === "tool_result") {
    return [];
  }

  if (typeof value.text === "string") {
    return [value.text];
  }

  const fields = ["message", "content", "prompt", "compact_summary", "summary"];
  return fields.flatMap((field) => extractContent(value[field], depth + 1));
}

function transcriptToMarkdown(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { markdown: "", turnCount: 0 };
  }

  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
  const blocks = [];

  for (const line of lines) {
    const entry = parseJsonMaybe(line);
    if (!entry) {
      continue;
    }

    const role = entry.message?.role || entry.role || entry.type || "entry";
    if (!["user", "assistant", "summary", "system"].includes(role)) {
      continue;
    }

    const text = extractContent(entry).join("\n").trim();
    if (!text) {
      continue;
    }

    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role;
    blocks.push(`### ${label}\n\n${text}`);
  }

  const recentBlocks = blocks.slice(-maxTurns);
  return { markdown: recentBlocks.join("\n\n"), turnCount: recentBlocks.length };
}

function safeWorkspaceName(cwd) {
  const base = path.basename(String(cwd || "").replace(/\/+$/, ""));
  return base || "workspace";
}

function buildMemoryDocument(rawInput) {
  const hookInput = parseJsonMaybe(rawInput);
  const now = new Date();
  const sessionId = hookInput?.session_id || "manual";
  const cwd = hookInput?.cwd || process.cwd();
  const hookEvent = hookInput?.hook_event_name || mode;
  const reason = redact(String(hookInput?.reason || hookInput?.trigger || ""))
    .replace(/\s+/g, " ")
    .slice(0, 500);
  const transcriptPath = hookInput?.transcript_path || "";

  let body = "";
  let turnCount = 0;

  if (hookInput?.compact_summary) {
    body = `## Compact Summary\n\n${hookInput.compact_summary}`;
    turnCount = 1;
  } else if (transcriptPath) {
    const transcript = transcriptToMarkdown(transcriptPath);
    body = transcript.markdown;
    turnCount = transcript.turnCount;
  } else {
    body = "";
  }

  body = redact(body).trim();

  const minTurns = mode === "pre-compact" ? preCompactMinTurns : sessionEndMinTurns;
  if (mode !== "post-compact" && turnCount < minTurns) {
    throw new SkipMemory(
      `Only ${turnCount} transcript turns available; minimum for ${mode} is ${minTurns}`,
    );
  }

  if (body.length > maxChars) {
    body = `${body.slice(-maxChars)}\n\n[Truncated to last ${maxChars} characters by memory hook.]`;
  }

  if (!body) {
    throw new SkipMemory(`No usable memory content found for ${mode}`);
  }

  const title = `${hookEvent} ${sessionId}`;
  const metadata = [
    "---",
    `captured_at: ${now.toISOString()}`,
    `hook_event: ${hookEvent}`,
    `session_id: ${sessionId}`,
    `reason: ${reason}`,
    `workspace_name: ${safeWorkspaceName(cwd)}`,
    `transcript_available: ${Boolean(transcriptPath)}`,
    `turn_count: ${turnCount}`,
    `max_turns: ${maxTurns}`,
    "---",
  ].join("\n");

  return {
    sessionId,
    name: `${now.toISOString()}-${hookEvent}-${sessionId}.md`
      .replace(/[:]/g, "-")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 180),
    content: `${metadata}\n\n# ${title}\n\n${body || "[No text content extracted.]"}\n`,
  };
}

function dockerContainerRunning(containerName) {
  const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", containerName], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function uploadToDify(document) {
  const env = fileEnv;
  const containerName = env.MCP_CONTAINER_NAME || "__MEMORY_SERVER_NAME__";
  const datasetId = env.DIFY_WRITE_DATASET_ID || String(env.DIFY_DATASET_IDS || "").split(",")[0];

  if (!env.DIFY_KNOWLEDGE_API_KEY || !datasetId) {
    throw new SkipMemory(
      "DIFY_KNOWLEDGE_API_KEY and DIFY_WRITE_DATASET_ID/DIFY_DATASET_IDS are not configured",
    );
  }

  if (!dockerContainerRunning(containerName)) {
    throw new SkipMemory(`${containerName} is not running`);
  }

  const result = spawnSync(
    "docker",
    ["exec", "-i", containerName, "node", "src/ingest-session.js", "--name", document.name],
    {
      input: document.content,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Dify ingest failed");
  }

  return result.stdout.trim();
}

try {
  const rawInput = readStdin();
  const document = buildMemoryDocument(rawInput);
  const upload = uploadToDify(document);

  console.error(`Memory queued in Dify as ${document.name}`);
  if (upload) {
    console.error(upload.split(/\r?\n/)[0]);
  }
} catch (error) {
  if (error instanceof SkipMemory) {
    console.error(`Memory hook skipped: ${error.message}`);
    process.exit(0);
  }

  console.error(`Memory hook failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
