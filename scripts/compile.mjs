import fs from "node:fs";
import path from "node:path";
import { COMPILE_STATE_PATH, PROMPTS_DIR, envInt, envValue } from "./lib/env.mjs";
import { callLLMWithRetry, LLMProviderUnavailable, LLMOutputInvalid } from "./lib/llm.mjs";
import {
  listDocuments,
  readDocument,
  searchMemory,
  writeMemory,
  disableDocument,
  DifyBridgeUnavailable,
} from "./lib/dify-write.mjs";
import { knowledgeDocName, parseDailyDocName, parseKnowledgeDocName } from "./lib/slug.mjs";

const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");
const SEARCH_LIMIT = envInt("MEMORY_COMPILE_SEARCH_LIMIT", 5);

function readState() {
  if (!fs.existsSync(COMPILE_STATE_PATH)) {
    return { last_attempted_date: "", last_run_iso: "", actions: { create: 0, update: 0, skip: 0, error: 0 } };
  }
  try {
    return JSON.parse(fs.readFileSync(COMPILE_STATE_PATH, "utf8"));
  } catch {
    return { last_attempted_date: "", last_run_iso: "", actions: { create: 0, update: 0, skip: 0, error: 0 } };
  }
}

function writeState(state) {
  fs.writeFileSync(COMPILE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function appendCompileLog(entry) {
  const log = `${COMPILE_STATE_PATH}.log`;
  fs.appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseAtomsFromMarkdown(text) {
  const atoms = [];
  const blocks = text.split(/\n(?=### Atom )/);
  for (const block of blocks) {
    if (!block.startsWith("### Atom")) continue;
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
        case "type": type = rest.trim(); break;
        case "title": title = rest.trim(); break;
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
        default: break;
      }
    }
    if (type && title && body) atoms.push({ type, title, body, tags, evidence });
  }
  return atoms;
}

function loadPrompt() {
  return fs.readFileSync(path.join(PROMPTS_DIR, "compile.md"), "utf8");
}

async function knowledgeCandidates(atom) {
  const query = `${atom.title}${atom.tags.length ? " " + atom.tags.join(" ") : ""}`;
  const result = await searchMemory({ query, limit: Math.max(SEARCH_LIMIT * 3, 15) });
  const records = Array.isArray(result?.records) ? result.records : [];
  const seen = new Set();
  const knowledge = [];
  for (const rec of records) {
    if (!rec?.documentName || !parseKnowledgeDocName(rec.documentName)) continue;
    if (seen.has(rec.documentId)) continue;
    seen.add(rec.documentId);
    knowledge.push(rec);
    if (knowledge.length >= SEARCH_LIMIT) break;
  }
  return knowledge;
}

function buildKnowledgeDocText(atom, mergedTextOverride) {
  const lines = [
    `# ${atom.title}`,
    "",
    `- type: ${atom.type}`,
    `- tags: [${atom.tags.join(", ")}]`,
    `- updated_at_utc: ${new Date().toISOString()}`,
    "",
    mergedTextOverride && mergedTextOverride.trim() ? mergedTextOverride.trim() : atom.body,
  ];
  if (!mergedTextOverride && atom.evidence) {
    lines.push("", `evidence: ${atom.evidence}`);
  }
  return lines.join("\n").concat("\n");
}

async function decideAction(atom, candidates, systemPrompt) {
  const userPrompt = [
    "NEW ATOM:",
    JSON.stringify(atom, null, 2),
    "",
    "EXISTING KNOWLEDGE CANDIDATES:",
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

async function executeAction(atom, decision, candidates) {
  const knowledgeDataset = envValue("DIFY_COMPILE_DATASET", "knowledge");
  if (decision.action === "skip") {
    return { ok: true, action: "skip", reason: decision.reason };
  }
  if (decision.action === "create") {
    const text = buildKnowledgeDocText(atom);
    const name = knowledgeDocName(atom.title);
    if (DRY_RUN) return { ok: true, dryRun: true, action: "create", name };
    return writeMemory({ name, text, datasetId: knowledgeDataset });
  }
  if (decision.action === "update") {
    if (!decision.supersedes) throw new Error("update action missing supersedes");
    const merged = String(decision.merged_text || "").trim();
    if (!merged) throw new Error("update action missing merged_text");
    const candidate = candidates.find((c) => c.documentId === decision.supersedes);
    const parsed = candidate ? parseKnowledgeDocName(candidate.documentName) : null;
    const slugSource = parsed?.slug ? parsed.slug : (decision.merged_name || atom.title);
    const text = buildKnowledgeDocText({ ...atom, title: decision.merged_name || atom.title }, merged);
    const name = knowledgeDocName(slugSource);
    if (DRY_RUN) {
      return { ok: true, dryRun: true, action: "update", name, supersedes: decision.supersedes };
    }
    return writeMemory({
      name,
      text,
      datasetId: knowledgeDataset,
      supersedes: decision.supersedes,
      supersedesAction: "disable",
    });
  }
  throw new Error(`unknown decision action: ${decision.action}`);
}

async function main() {
  const dailyDataset = envValue("DIFY_FLUSH_DATASET", "daily");
  let dailies;
  try {
    const result = await listDocuments({ prefix: "daily-", enabled: "true", datasetId: dailyDataset });
    dailies = Array.isArray(result?.documents) ? result.documents : [];
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) {
      console.error(`compile.mjs: bridge unavailable: ${err.message}`);
      process.exit(0);
    }
    throw err;
  }

  const filtered = dailies.filter((d) => parseDailyDocName(d?.name));
  if (filtered.length === 0) {
    console.error("compile.mjs: no enabled daily-* docs to promote");
    return;
  }

  const sorted = filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  console.error(`compile.mjs: found ${sorted.length} daily doc(s) to promote`);

  const systemPrompt = loadPrompt();
  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  let promotedDocs = 0;

  for (const daily of sorted) {
    let docText;
    try {
      const r = await readDocument({ documentId: daily.id, datasetId: dailyDataset });
      docText = r?.text || "";
    } catch (err) {
      counts.error += 1;
      appendCompileLog({ event: "read-error", document: daily.name, error: err.message || String(err) });
      if (err instanceof DifyBridgeUnavailable) {
        console.error(`compile.mjs: aborting, bridge gone: ${err.message}`);
        process.exit(0);
      }
      continue;
    }

    const atoms = parseAtomsFromMarkdown(docText);
    if (atoms.length === 0) {
      if (!DRY_RUN) {
        try {
          await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
          appendCompileLog({ event: "disable-empty", document: daily.name });
        } catch (err) {
          counts.error += 1;
          appendCompileLog({ event: "disable-error", document: daily.name, error: err.message || String(err) });
        }
      }
      continue;
    }

    let allOk = true;
    for (const atom of atoms) {
      try {
        const candidates = await knowledgeCandidates(atom);
        const decision = await decideAction(atom, candidates, systemPrompt);
        if (!decision || typeof decision !== "object" || !decision.action) {
          throw new LLMOutputInvalid("compile decision missing 'action'", JSON.stringify(decision));
        }
        const result = await executeAction(atom, decision, candidates);
        counts[decision.action] = (counts[decision.action] || 0) + 1;
        appendCompileLog({
          event: "atom",
          source: daily.name,
          atomTitle: atom.title,
          action: decision.action,
          supersedes: decision.supersedes,
          dryRun: DRY_RUN,
        });
        if (!DRY_RUN && result?.ok === false) throw new Error(JSON.stringify(result));
      } catch (err) {
        allOk = false;
        counts.error += 1;
        appendCompileLog({
          event: "atom-error",
          source: daily.name,
          atomTitle: atom.title,
          error: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof DifyBridgeUnavailable || err instanceof LLMProviderUnavailable) {
          console.error(`compile.mjs: aborting (${err.constructor.name}): ${err.message}`);
          process.exit(0);
        }
      }
    }

    if (allOk && !DRY_RUN) {
      try {
        await disableDocument({ documentId: daily.id });
        appendCompileLog({ event: "disable", document: daily.name });
        promotedDocs += 1;
      } catch (err) {
        counts.error += 1;
        appendCompileLog({ event: "disable-error", document: daily.name, error: err.message || String(err) });
      }
    } else if (!allOk) {
      appendCompileLog({ event: "kept-enabled", document: daily.name, reason: "atom errors; will retry next compile" });
    }
  }

  const state = readState();
  state.last_attempted_date = todayUtcDate();
  state.last_run_iso = new Date().toISOString();
  state.actions = {
    create: (state.actions?.create || 0) + counts.create,
    update: (state.actions?.update || 0) + counts.update,
    skip: (state.actions?.skip || 0) + counts.skip,
    error: (state.actions?.error || 0) + counts.error,
  };
  writeState(state);

  console.error(
    `compile.mjs: promoted ${promotedDocs} daily doc(s); actions create=${counts.create} update=${counts.update} skip=${counts.skip} error=${counts.error}`,
  );
}

await main();
