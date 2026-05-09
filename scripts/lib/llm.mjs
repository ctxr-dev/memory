import { spawn } from "node:child_process";
import { envValue, envInt } from "./env.mjs";

export class LLMProviderUnavailable extends Error {}
export class LLMOutputInvalid extends Error {
  constructor(message, raw) {
    super(message);
    this.raw = raw;
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function callLLM({ systemPrompt, userPrompt, maxTokens = 1500 }) {
  const provider = (envValue("MEMORY_LLM_PROVIDER", "claude") || "claude").toLowerCase();
  const timeoutMs = envInt("MEMORY_LLM_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);

  let raw;
  switch (provider) {
    case "claude":
      raw = await callClaudeCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "codex":
      raw = await callCodexCli({ systemPrompt, userPrompt, timeoutMs });
      break;
    case "anthropic":
      raw = await callAnthropicApi({ systemPrompt, userPrompt, maxTokens, timeoutMs });
      break;
    case "openai":
      raw = await callOpenAiApi({ systemPrompt, userPrompt, maxTokens, timeoutMs });
      break;
    default:
      throw new LLMProviderUnavailable(`Unknown MEMORY_LLM_PROVIDER: ${provider}`);
  }

  return parseStrictJson(raw);
}

export async function callLLMWithRetry(args) {
  try {
    return await callLLM(args);
  } catch (err) {
    if (!(err instanceof LLMOutputInvalid)) throw err;
    const stricter = {
      ...args,
      userPrompt:
        `${args.userPrompt}\n\n---\nIMPORTANT: respond with STRICT JSON only. ` +
        `No prose before or after. No markdown code fences.`,
    };
    return callLLM(stricter);
  }
}

function parseStrictJson(raw) {
  const text = stripCodeFence(String(raw || "").trim());
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}\s*$|^\s*\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // fall through
      }
    }
    throw new LLMOutputInvalid("LLM output was not valid JSON", text);
  }
}

function stripCodeFence(text) {
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  return fence ? fence[1] : text;
}

async function spawnCapture(cmd, args, { input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LLMProviderUnavailable(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new LLMProviderUnavailable(`${cmd} failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const errOut = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new LLMProviderUnavailable(`${cmd} exited ${code}: ${errOut.trim() || out.trim()}`));
        return;
      }
      resolve(out);
    });

    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function callClaudeCli({ systemPrompt, userPrompt, timeoutMs }) {
  const args = ["-p", "--output-format=json", "--max-turns=1"];
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  args.push(userPrompt);
  const raw = await spawnCapture("claude", args, { timeoutMs });
  try {
    const wrapper = JSON.parse(raw);
    if (typeof wrapper?.result === "string") return wrapper.result;
    if (typeof wrapper?.text === "string") return wrapper.text;
    if (Array.isArray(wrapper?.content)) {
      const text = wrapper.content.find((c) => typeof c?.text === "string")?.text;
      if (text) return text;
    }
    return raw;
  } catch {
    return raw;
  }
}

async function callCodexCli({ systemPrompt, userPrompt, timeoutMs }) {
  const combined = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
  const candidates = [
    ["exec", "--json", combined],
    ["exec", combined],
  ];
  let lastErr;
  for (const args of candidates) {
    try {
      const raw = await spawnCapture("codex", args, { timeoutMs });
      try {
        const wrapper = JSON.parse(raw);
        if (typeof wrapper?.result === "string") return wrapper.result;
        if (typeof wrapper?.output === "string") return wrapper.output;
        if (Array.isArray(wrapper?.messages)) {
          const text = wrapper.messages
            .map((m) => (typeof m?.content === "string" ? m.content : ""))
            .filter(Boolean)
            .join("\n");
          if (text) return text;
        }
        return raw;
      } catch {
        return raw;
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof LLMProviderUnavailable && /unknown.*--json|invalid argument/i.test(err.message)) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new LLMProviderUnavailable("codex exec failed");
}

async function callAnthropicApi({ systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  const apiKey = envValue("ANTHROPIC_API_KEY");
  const model = envValue("ANTHROPIC_MODEL", "claude-sonnet-4-6");
  if (!apiKey) throw new LLMProviderUnavailable("ANTHROPIC_API_KEY not set");

  const body = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt || undefined,
    messages: [{ role: "user", content: userPrompt }],
  };

  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderUnavailable(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.content?.find?.((c) => c?.type === "text")?.text;
  if (!text) throw new LLMOutputInvalid("Anthropic response missing text content", JSON.stringify(json));
  return text;
}

async function callOpenAiApi({ systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  const apiKey = envValue("OPENAI_API_KEY");
  const model = envValue("OPENAI_MODEL", "gpt-4o-mini");
  if (!apiKey) throw new LLMProviderUnavailable("OPENAI_API_KEY not set");

  const body = {
    model,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      { role: "user", content: userPrompt },
    ],
  };

  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new LLMProviderUnavailable(`OpenAI API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new LLMOutputInvalid("OpenAI response missing content", JSON.stringify(json));
  return text;
}

async function fetchWithTimeout(url, { timeoutMs, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
