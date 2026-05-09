import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DAILY_DIR, STATE_PATH, PROMPTS_DIR, envInt } from "./lib/env.mjs";
import { callLLMWithRetry, LLMProviderUnavailable, LLMOutputInvalid } from "./lib/llm.mjs";
import {
  searchMemory,
  writeMemory,
  DifyBridgeUnavailable,
} from "./lib/dify-write.mjs";

const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");
const RETENTION_DAYS = envInt("MEMORY_DAILY_RETENTION_DAYS", 30);
const SEARCH_LIMIT = envInt("MEMORY_COMPILE_SEARCH_LIMIT", 5);

function readState() {
  if (!fs.existsSync(STATE_PATH)) return { last_compiled_date: "", compiled_files: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { last_compiled_date: "", compiled_files: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function appendCompileLog(entry) {
  const log = `${STATE_PATH}.compile-log`;
  const ts = new Date().toISOString();
  fs.appendFileSync(log, `${JSON.stringify({ ts, ...entry })}\n`);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function listDailyFiles() {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs
    .readdirSync(DAILY_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => ({ name: f, date: f.slice(0, 10), full: path.join(DAILY_DIR, f) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseAtomsFromMarkdown(text) {
  const atoms = [];
  const blocks = text.split(/\n(?=### Atom )/);
  for (const block of blocks) {
    if (!block.startsWith("### Atom ")) continue;
    const lines = block.split(/\r?\n/);
    let type, title, tags = [], body = "", evidence;
    let inBody = false;
    for (const line of lines) {
      if (inBody) {
        if (line.startsWith("    ")) {
          body += (body ? "\n" : "") + line.slice(4);
          continue;
        }
        if (line.trim() === "" || line.startsWith("- ")) {
          inBody = false;
        } else {
          continue;
        }
      }
      const m = line.match(/^- (\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, rest] = m;
      switch (key) {
        case "type":
          type = rest.trim();
          break;
        case "title":
          title = rest.trim();
          break;
        case "tags": {
          const inner = rest.trim().replace(/^\[|\]$/g, "");
          tags = inner ? inner.split(",").map((t) => t.trim()).filter(Boolean) : [];
          break;
        }
        case "body":
          if (rest.trim() === "|") inBody = true;
          else body = rest.trim();
          break;
        case "evidence":
          try { evidence = JSON.parse(rest.trim()); } catch { evidence = rest.trim(); }
          break;
        default:
          break;
      }
    }
    if (type && title && body) atoms.push({ type, title, body, tags, evidence });
  }
  return atoms;
}

function loadPrompt() {
  const file = path.join(PROMPTS_DIR, "compile.md");
  return fs.readFileSync(file, "utf8");
}

async function searchCandidates(atom) {
  const query = `${atom.title}${atom.tags.length ? " " + atom.tags.join(" ") : ""}`;
  try {
    const result = await searchMemory({ query, limit: SEARCH_LIMIT });
    return Array.isArray(result?.records) ? result.records : [];
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) throw err;
    throw err;
  }
}

function buildAtomDocumentText(atom) {
  const lines = [
    `# ${atom.title}`,
    "",
    `type: ${atom.type}`,
    `tags: ${atom.tags.join(", ")}`,
    "",
    atom.body,
  ];
  if (atom.evidence) {
    lines.push("", `evidence: ${atom.evidence}`);
  }
  return lines.join("\n");
}

async function decideAction(atom, candidates, systemPrompt) {
  const userPrompt = [
    "NEW ATOM:",
    JSON.stringify(atom, null, 2),
    "",
    "EXISTING CANDIDATES:",
    candidates.length === 0
      ? "[]"
      : JSON.stringify(
          candidates.map((c) => ({
            documentId: c.documentId,
            documentName: c.documentName,
            score: c.score,
            content: String(c.content || "").slice(0, 800),
          })),
          null,
          2,
        ),
  ].join("\n");
  return callLLMWithRetry({ systemPrompt, userPrompt, maxTokens: 800 });
}

async function executeAction(atom, decision) {
  const safeName = `${atom.title.replace(/[^A-Za-z0-9 _.-]/g, " ").trim().slice(0, 120)}.md`;
  if (decision.action === "create") {
    const text = buildAtomDocumentText(atom);
    if (DRY_RUN) return { ok: true, dryRun: true, action: "create", name: safeName };
    return writeMemory({ name: safeName, text });
  }
  if (decision.action === "update") {
    const text = String(decision.merged_text || "").trim();
    const name = String(decision.merged_name || safeName).slice(0, 180);
    if (!text) throw new Error("update action missing merged_text");
    if (!decision.supersedes) throw new Error("update action missing supersedes");
    if (DRY_RUN) return { ok: true, dryRun: true, action: "update", supersedes: decision.supersedes, name };
    return writeMemory({ name, text, supersedes: decision.supersedes, supersedesAction: "disable" });
  }
  if (decision.action === "skip") return { ok: true, action: "skip", reason: decision.reason };
  throw new Error(`unknown decision action: ${decision.action}`);
}

function rotateOldLogs(stateNow) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  for (const file of listDailyFiles()) {
    if (file.date >= cutoff) continue;
    if (!stateNow.compiled_files[file.name]) continue;
    fs.unlinkSync(file.full);
    appendCompileLog({ event: "rotate", file: file.name });
  }
}

async function main() {
  const state = readState();
  const today = todayUtcDate();
  const files = listDailyFiles();

  if (files.length === 0) {
    console.error("compile.mjs: no daily logs to compile");
    return;
  }

  let processed = 0;
  let actionCounts = { create: 0, update: 0, skip: 0, error: 0 };
  let systemPrompt;

  for (const file of files) {
    if (!FORCE && file.date >= today) continue;
    const buf = fs.readFileSync(file.full);
    const hash = sha256(buf);
    if (state.compiled_files[file.name] === hash) continue;

    const atoms = parseAtomsFromMarkdown(buf.toString("utf8"));
    if (atoms.length === 0) {
      state.compiled_files[file.name] = hash;
      appendCompileLog({ event: "compile", file: file.name, atoms: 0 });
      continue;
    }

    if (!systemPrompt) systemPrompt = loadPrompt();

    for (const atom of atoms) {
      try {
        const candidates = await searchCandidates(atom);
        const decision = await decideAction(atom, candidates, systemPrompt);
        if (!decision || typeof decision !== "object" || !decision.action) {
          throw new LLMOutputInvalid("compile decision missing 'action'", JSON.stringify(decision));
        }
        const result = await executeAction(atom, decision);
        actionCounts[decision.action] = (actionCounts[decision.action] || 0) + 1;
        appendCompileLog({
          event: "atom",
          file: file.name,
          atomTitle: atom.title,
          action: decision.action,
          supersedes: decision.supersedes,
          dryRun: DRY_RUN,
        });
        if (!DRY_RUN && result?.ok === false) {
          throw new Error(JSON.stringify(result));
        }
      } catch (err) {
        actionCounts.error += 1;
        appendCompileLog({
          event: "atom-error",
          file: file.name,
          atomTitle: atom.title,
          error: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof DifyBridgeUnavailable || err instanceof LLMProviderUnavailable) {
          console.error(`compile.mjs: aborting (${err.constructor.name}): ${err.message}`);
          process.exit(0);
        }
      }
    }

    state.compiled_files[file.name] = hash;
    state.last_compiled_date = today;
    writeState(state);
    processed += 1;
  }

  rotateOldLogs(state);

  console.error(
    `compile.mjs: processed ${processed} log(s); actions create=${actionCounts.create} update=${actionCounts.update} skip=${actionCounts.skip} error=${actionCounts.error}`,
  );
}

await main();
