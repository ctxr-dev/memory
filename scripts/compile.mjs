import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { COMPILE_LOCK_PATH, COMPILE_STATE_PATH, PROMPTS_DIR, envInt, envValue, atomBodyMaxChars } from "./lib/env.mjs";
import { acquireLock, installLockReleaseHandlers } from "./lib/lock.mjs";
import { callLLMWithRetry, LLMProviderUnavailable, LLMOutputInvalid } from "./lib/llm.mjs";
import {
  listDocuments,
  readDocument,
  searchMemoryFiltered,
  writeMemory,
  disableDocument,
  updateDocMetadata,
  DifyBridgeUnavailable,
} from "./lib/dify-write.mjs";
import {
  knowledgeDocName,
  lessonDocName,
  parseDailyDocName,
  parseKnowledgeDocName,
  parseLessonDocName,
} from "./lib/slug.mjs";
import { ATOM_TYPE_TO_DATASET, ATOM_TYPES, metadataForDify } from "./lib/datasets.mjs";

const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");
const SEARCH_LIMIT = envInt("MEMORY_COMPILE_SEARCH_LIMIT", 5);
const METADATA_RETRY_LIMIT = envInt("MEMORY_COMPILE_METADATA_RETRY_LIMIT", 3);
// When true, atoms failing scoreAtomQuality are dropped before promotion.
// Default false: log the verdict but keep the existing conservative
// behaviour so the v0.1.0 cut doesn't silently change what makes it into
// the knowledge store. Opt in via MEMORY_COMPILE_QUALITY_STRICT=true once
// the rubric is tuned.
const QUALITY_STRICT = String(envValue("MEMORY_COMPILE_QUALITY_STRICT", "")).toLowerCase() === "true";
// How many UTC calendar days of raw daily docs stay enabled (searchable)
// before compile retires (disables) them. Default one week. A daily older
// than this is aged out: promoted if not already, then disabled.
const ACTIVE_DAYS = envInt("MEMORY_DAILY_ACTIVE_DAYS", 7);

// Whole UTC days between two YYYY-MM-DD strings (toDate - fromDate).
export function daysBetweenUtc(fromDate, toDate) {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

// Pure decision for one daily doc, by its date vs today and the active
// window. The window covers the most recent `activeDays` UTC days counting
// today, so a daily stays enabled while ageDays < activeDays and is retired
// once ageDays >= activeDays. With the default 7, today plus the previous 6
// days stay searchable; a daily that reaches 7 days old is disabled.
// Returned verbs drive the compile loop:
//   skip-today    -> today's (or future) doc, still accumulating; leave enabled
//   promote       -> complete & within window, not yet promoted; promote, keep enabled
//   skip-promoted -> complete & within window, already promoted; do nothing
//   retire        -> at/over the window age; promote-if-needed then disable
export function classifyDaily({ name, todayUtc, activeDays, promoted, wordCount }) {
  const parsed = parseDailyDocName(name);
  // Unparseable names are left untouched (never auto-disabled): safest default.
  if (!parsed) return "skip-today";
  const ageDays = daysBetweenUtc(parsed.date, todayUtc);
  if (!Number.isFinite(ageDays) || ageDays <= 0) return "skip-today";
  if (ageDays >= activeDays) return "retire";
  const map = promoted && typeof promoted === "object" && !Array.isArray(promoted) ? promoted : {};
  if (!Object.prototype.hasOwnProperty.call(map, name)) return "promote";
  // Re-promote if the daily's content CHANGED since it was promoted: a detached
  // flush worker can append more atoms to an already-promoted (still-in-window)
  // day, even across UTC midnight. word_count is the cheap change signal (it
  // comes free on the listing, no extra read). On re-promote the LLM dedup
  // skips/updates the already-promoted atoms, so only genuinely new atoms create
  // knowledge docs. Unchanged days short-circuit here (the common case).
  return map[name] === (wordCount ?? null) ? "skip-promoted" : "promote";
}

function defaultState() {
  return {
    last_attempted_date: "",
    last_run_iso: "",
    actions: { create: 0, update: 0, skip: 0, error: 0 },
    metadata_retry: {},   // dailyDocId -> attempt count
    promoted_dailies: {},  // { dailyName: wordCount } promoted + kept enabled within the active window; word_count is the change signal for re-promote-on-append
  };
}

function readState() {
  if (!fs.existsSync(COMPILE_STATE_PATH)) return defaultState();
  try {
    const raw = JSON.parse(fs.readFileSync(COMPILE_STATE_PATH, "utf8"));
    return {
      ...defaultState(),
      ...raw,
      metadata_retry: raw.metadata_retry || {},
      // Map { name: wordCount }. A legacy array (or anything non-object) resets
      // to {} so in-window days are re-promoted once to capture their fingerprint
      // (the LLM dedup makes that a safe no-op for already-promoted atoms).
      promoted_dailies:
        raw.promoted_dailies && typeof raw.promoted_dailies === "object" && !Array.isArray(raw.promoted_dailies)
          ? raw.promoted_dailies
          : {},
    };
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  // Atomic write: stage to .tmp then rename. The lockfile already
  // serialises healthy concurrent writers, but a SIGKILL or hard crash
  // mid-`writeFileSync` would leave the file truncated. readState
  // recovers gracefully (returns defaultState) but that silently wipes
  // metadata_retry counters — defeating the bounded-retry cap that
  // prevents duplicate-create loops on a stuck daily.
  const tmp = `${COMPILE_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, COMPILE_STATE_PATH);
}

function appendCompileLog(entry) {
  const log = `${COMPILE_STATE_PATH}.log`;
  fs.appendFileSync(log, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

export function parseAtomsFromMarkdown(text) {
  const atoms = [];
  // Atom heading delimiter. Rendered as "### Atom · <type> · <title>", but
  // Dify's segment read-back strips the leading "###" from the heading that
  // begins a chunk (in practice the first atom after each session header),
  // while atoms deeper in the chunk keep it. Match EITHER "#{1,6} Atom · "
  // (hashes + a space) OR a column-0 "Atom · " (the Dify-stripped form) — but
  // NOT a bare leading-space "Atom · ", because Dify collapses body-line indent
  // to a single space and a body line literally starting "Atom · " must not be
  // mistaken for a heading.
  const ATOM_HEADING = /^(?:#{1,6} )?Atom · /;
  const blocks = text.split(/\n(?=(?:#{1,6} )?Atom · )/);
  for (const block of blocks) {
    if (!ATOM_HEADING.test(block)) continue;
    const lines = block.split(/\r?\n/);
    let type, title, tags = [], body = "", evidence;
    let metadata = {};
    let inBody = false;
    for (const line of lines) {
      if (inBody) {
        // Body lines are rendered with a 4-space indent. Dify's segments
        // read-back collapses leading whitespace (4 spaces -> 1), so a daily
        // round-tripped through Dify presents body lines with a single
        // leading SPACE. Accept a leading-space line as a body continuation and
        // strip up to 4 leading spaces: slice(4)-equivalent for pristine text
        // (preserves deeper intentional indentation) and also recovers the
        // collapsed single-space form. Detection and stripping are both
        // space-only (the renderer never emits tabs); field lines (`- type:`)
        // and the header stay at column 0, so they still terminate the body.
        if (/^ /.test(line)) {
          body += (body ? "\n" : "") + line.replace(/^ {1,4}/, "");
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
        case "metadata": {
          try {
            const parsed = JSON.parse(rest.trim());
            metadata = (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
          } catch {
            metadata = {};
          }
          break;
        }
        case "body":
          if (rest.trim() === "|") inBody = true;
          else body = rest.trim();
          break;
        case "evidence": {
          // flush.mjs always JSON.stringifies the evidence string, so a
          // valid daily produces a JSON-encoded one-liner here (newlines
          // and embedded quotes are escape-encoded). Hand-edited dailies
          // may carry a raw string, so fall back to the trimmed literal
          // on parse failure. Guard the unusual case where parse succeeds
          // but yields a non-string (e.g. evidence: null) — coerce.
          const raw = rest.trim();
          try {
            const parsed = JSON.parse(raw);
            evidence = typeof parsed === "string" ? parsed : raw;
          } catch {
            evidence = raw;
          }
          break;
        }
        default: break;
      }
    }
    if (!type || !title || !body) continue;
    // Re-validate atom type against the central registry. A daily doc
    // produced by an older flush.mjs (or hand-edited) might carry a
    // typo'd type; promoting it would route to the wrong dataset.
    if (!ATOM_TYPES.has(type)) {
      console.error(`compile.mjs: skipping atom with unknown type '${type}' (title='${title.slice(0, 40)}')`);
      continue;
    }
    atoms.push({ type, title, body, tags, metadata, evidence });
  }
  return atoms;
}

function loadPrompt() {
  const cap = atomBodyMaxChars();
  return fs.readFileSync(path.join(PROMPTS_DIR, "compile.md"), "utf8")
    .replace(/\{\{ATOM_BODY_MAX_CHARS\}\}/g, String(cap));
}

function targetDatasetForAtom(atom) {
  const fallback = envValue("DIFY_COMPILE_DATASET", "knowledge");
  return ATOM_TYPE_TO_DATASET[atom.type] || fallback;
}

function parserForAtom(atom) {
  return atom.type === "self-improvement-lesson" ? parseLessonDocName : parseKnowledgeDocName;
}

function nameBuilderForAtom(atom) {
  return atom.type === "self-improvement-lesson" ? lessonDocName : knowledgeDocName;
}

// Build the metadata-condition filter for compile-time candidate retrieval.
// Tighter filters give the LLM cleaner candidates and bias toward update over
// create.
function compileFilters(atom) {
  const filters = { atom_type: atom.type };
  if (atom.metadata?.project_module) filters.project_module = atom.metadata.project_module;
  if (atom.metadata?.language) filters.language = atom.metadata.language;
  if (atom.metadata?.error_pattern) filters.error_pattern = atom.metadata.error_pattern;
  return filters;
}

async function dedupCandidates(atom, targetDataset) {
  const query = `${atom.title}${atom.tags.length ? " " + atom.tags.join(" ") : ""}`;
  const result = await searchMemoryFiltered({
    query,
    datasetId: targetDataset,
    limit: Math.max(SEARCH_LIMIT, 5),
    filters: compileFilters(atom),
  });
  const records = Array.isArray(result?.records) ? result.records : [];
  const parser = parserForAtom(atom);
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    if (!rec?.documentName || !parser(rec.documentName)) continue;
    if (seen.has(rec.documentId)) continue;
    seen.add(rec.documentId);
    out.push(rec);
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
}

function buildPromotedDocText(atom, mergedTextOverride) {
  const md = atom.metadata || {};
  const lines = [
    `# ${atom.title}`,
    "",
    `- type: ${atom.type}`,
    `- tags: [${atom.tags.join(", ")}]`,
    `- project_module: ${md.project_module || ""}`,
    `- language: ${md.language || ""}`,
    `- task_type: ${md.task_type || ""}`,
    `- error_pattern: ${md.error_pattern || ""}`,
    `- updated_at_utc: ${new Date().toISOString()}`,
    "",
    mergedTextOverride && mergedTextOverride.trim() ? mergedTextOverride.trim() : atom.body,
  ];
  if (!mergedTextOverride && atom.evidence) {
    lines.push("", `evidence: ${atom.evidence}`);
  }
  return lines.join("\n").concat("\n");
}

// Deterministic short-circuit for self-improvement-lessons that share an
// error_pattern with an existing candidate. compileFilters already filters
// candidates by `error_pattern` server-side when the atom has one set, so
// any returned candidate is by definition a same-pattern match. Lessons
// must converge into ONE canonical doc per error pattern (this is the
// documented contract in prompts/flush.md + prompts/compile.md), so the
// only sane action is `update` against the top candidate. Skipping the
// LLM here keeps the rule from drifting on prompt edits and saves a
// round-trip per same-pattern lesson.
//
// IMPORTANT: this is a REPLACE, not a true merge. The prompt contract
// for `update` says "Preserves the WHY and HOW-TO-APPLY lines from BOTH
// atoms" — but that merge requires the LLM. Here we set
// `merged_text = atom.body` (the new atom only). The deliberate trade:
// (a) the new atom is the most recent ground truth on the failure
//     mode, per prompts/compile.md's "the new one wins" rule for
//     contradictions;
// (b) cost: we lose any evidence the OLD doc had that the new one
//     doesn't repeat. In practice the old doc is itself a prior
//     compile-merged lesson, so losing one round of merged context
//     is a one-time cost, not cumulative;
// (c) benefit: zero LLM tokens per same-pattern lesson, and no risk
//     of the LLM hallucinating a wrong documentId (the long-standing
//     LLMOutputInvalid failure mode in executeAction's update path).
// If you need a real merge here someday, swap `atom.body` for an
// LLM-merged string but keep the bypass when the LLM is unavailable.
// Heuristic quality rubric for `create` actions. Cheap (no LLM, just
// inspections) signals that an atom is high-signal-density and worth
// persisting. Returns { ok: boolean, reasons: string[] }. Reasons are
// human-readable strings safe to log. Used by compile.mjs when
// MEMORY_COMPILE_QUALITY_STRICT=true to drop low-signal atoms before
// they pollute retrieval. Default lax mode (env-var unset/false) only
// surfaces the verdict for forensics; the atom is still promoted.
//
// Rubric (every rule must pass):
// 1. `body` length >= 80 chars — under that, the atom is usually a
//    one-liner that adds no context beyond the title.
// 2. At least one tag — recall surfaces atoms via tags and content; an
//    untagged atom only matches on the title/body embedding.
// 3. `evidence` present OR body contains a "Why:" or "How to apply:"
//    line — structured atoms ("Why" + "How to apply") are the
//    documented format in prompts/flush.md; an unstructured wall of
//    text is usually narrative leaking through.
// 4. For `self-improvement-lesson` and `bug-root-cause`:
//    `metadata.project_module` is set — these atoms are the most
//    metadata-dependent in retrieval (recall_lessons filters by
//    project_module by default). An atom without one is invisible to
//    the scoped recall path.
export function scoreAtomQuality(atom) {
  const reasons = [];
  const body = String(atom?.body || "");
  if (body.length < 80) reasons.push("body too short (<80 chars)");
  const tags = Array.isArray(atom?.tags) ? atom.tags.filter(Boolean) : [];
  if (tags.length === 0) reasons.push("no tags");
  const hasEvidence = Boolean(String(atom?.evidence || "").trim());
  const hasWhyOrHowTo = /(^|\n)\s*(why|how to apply)\s*:/i.test(body);
  if (!hasEvidence && !hasWhyOrHowTo) reasons.push("no evidence and no 'Why:' / 'How to apply:' lines");
  const metadataDependentTypes = new Set(["self-improvement-lesson", "bug-root-cause"]);
  if (metadataDependentTypes.has(atom?.type) && !atom?.metadata?.project_module) {
    reasons.push(`type='${atom.type}' requires metadata.project_module`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function forcedLessonUpdate(atom, candidates) {
  if (!atom || typeof atom !== "object") return null;
  if (atom.type !== "self-improvement-lesson") return null;
  if (!atom.metadata?.error_pattern) return null;
  if (!candidates || candidates.length === 0) return null;
  const top = candidates[0];
  if (!top?.documentId) return null;
  return {
    action: "update",
    supersedes: top.documentId,
    merged_text: atom.body,
    merged_name: atom.title,
    reason: `forced update: same error_pattern='${atom.metadata.error_pattern}' as candidate ${top.documentId}`,
  };
}

async function decideAction(atom, candidates, systemPrompt) {
  const forced = forcedLessonUpdate(atom, candidates);
  if (forced) return forced;
  const userPrompt = [
    "NEW ATOM:",
    JSON.stringify(atom, null, 2),
    "",
    `EXISTING CANDIDATES (already filtered by atom_type=${atom.type} and matching metadata):`,
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

async function executeAction(atom, decision, candidates, targetDataset) {
  if (decision.action === "skip") {
    return { ok: true, action: "skip", reason: decision.reason };
  }
  const buildName = nameBuilderForAtom(atom);
  if (decision.action === "create") {
    const text = buildPromotedDocText(atom);
    const name = buildName(atom.title);
    if (DRY_RUN) return { ok: true, dryRun: true, action: "create", name, datasetId: targetDataset };
    return writeMemory({ name, text, datasetId: targetDataset });
  }
  if (decision.action === "update") {
    if (!decision.supersedes) throw new Error("update action missing supersedes");
    const merged = String(decision.merged_text || "").trim();
    if (!merged) throw new Error("update action missing merged_text");
    const candidate = candidates.find((c) => c.documentId === decision.supersedes);
    // The LLM may hallucinate a documentId not in the candidate set.
    // Without this check, writeMemory would create a new doc and then
    // disableDocument would 404 against a nonexistent id, leaving a
    // duplicate in the target dataset. Refuse and let the retry path
    // re-prompt for a valid decision.
    if (!candidate) {
      throw new LLMOutputInvalid(
        `update.supersedes='${decision.supersedes}' is not in the candidate set; the LLM hallucinated an id`,
        JSON.stringify(decision),
      );
    }
    const parser = parserForAtom(atom);
    const parsed = candidate ? parser(candidate.documentName) : null;
    const slugSource = parsed?.slug ? parsed.slug : (decision.merged_name || atom.title);
    const text = buildPromotedDocText({ ...atom, title: decision.merged_name || atom.title }, merged);
    const name = buildName(slugSource);
    if (DRY_RUN) {
      return { ok: true, dryRun: true, action: "update", name, supersedes: decision.supersedes, datasetId: targetDataset };
    }
    return writeMemory({
      name,
      text,
      datasetId: targetDataset,
      supersedes: decision.supersedes,
      supersedesAction: "disable",
    });
  }
  throw new Error(`unknown decision action: ${decision.action}`);
}

// After writeMemory creates the new document, set the per-document Dify
// metadata so subsequent retrieve calls can filter on it. Failure is
// recorded but does not abort the compile run — EXCEPT bridge-unavailable
// errors are re-thrown so the outer per-atom catch can fire `process.exit(0)`
// instead of grinding through more dailies against a dead bridge.
async function applyMetadataToWritten(atom, writeResult, targetDataset) {
  if (!writeResult || writeResult.dryRun) return null;
  const docId = writeResult?.created?.document?.id || writeResult?.created?.id;
  if (!docId) return { ok: false, reason: "writeMemory response missing created.document.id" };
  const md = metadataForDify(atom);
  try {
    return await updateDocMetadata({ datasetId: targetDataset, documentId: docId, metadata: md });
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) throw err;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  // Acquire an exclusive compile lock. Two SessionStarts can spawn
  // detached compiles concurrently; without this, both would load
  // .compile-state.json, mutate it independently, and the last writer
  // wins. The metadata_retry counter would regress and an atom could be
  // promoted twice (once by each compile).
  const lockStaleMs = envInt("MEMORY_COMPILE_LOCK_STALE_MS", 1_800_000);
  installLockReleaseHandlers(COMPILE_LOCK_PATH);
  const lock = acquireLock(COMPILE_LOCK_PATH, { staleMs: lockStaleMs, label: "compile.mjs" });
  if (!lock.ok) {
    console.error(`compile.mjs: skipping (${lock.reason})`);
    process.exit(0);
  }

  const dailyDataset = envValue("DIFY_FLUSH_DATASET", "daily");
  let dailies;
  try {
    const listOpts = { prefix: "daily-", datasetId: dailyDataset };
    if (!FORCE) listOpts.enabled = "true";
    const result = await listDocuments(listOpts);
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

  // Load state up front so the per-daily loop can use + update
  // metadata_retry counts. Saved at the bottom along with action counts.
  const state = readState();
  const systemPrompt = loadPrompt();

  // Schema-missing warnings: print to stderr at most ONCE per dataset per
  // compile run so an operator notices that promoted docs are
  // un-filterable. Without this, the warning was buried in the JSON log
  // and silently lost.
  const warnedSchemaMissing = new Set();
  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  let promotedDocs = 0;

  // Active window bookkeeping. `promoted` maps an already-promoted day's name to
  // the word_count it had when promoted; the day stays ENABLED for the window
  // and is NOT re-promoted unless its word_count changes (a late/detached worker
  // appended more atoms). --force resets it so an operator can reprocess
  // everything. Mutated in place; persisted via writeState.
  const todayUtc = todayUtcDate();
  if (FORCE) state.promoted_dailies = {};
  const promoted = state.promoted_dailies;

  for (const daily of sorted) {
    const verb = classifyDaily({ name: daily.name, todayUtc, activeDays: ACTIVE_DAYS, promoted, wordCount: daily.wordCount });

    // Today's (or future-dated) doc is still accumulating sessions; leave it
    // enabled and untouched until it is a complete day.
    if (verb === "skip-today") {
      appendCompileLog({ event: "skip-today", document: daily.name });
      continue;
    }
    // Already promoted and still inside the active window: keep it enabled
    // and searchable, do not re-promote (no duplicate knowledge, no LLM cost).
    if (verb === "skip-promoted") {
      appendCompileLog({ event: "skip-promoted", document: daily.name });
      continue;
    }

    const retire = verb === "retire"; // older than the active window -> disable after this
    const alreadyPromoted = Object.prototype.hasOwnProperty.call(promoted, daily.name);

    // Aged out and already promoted: just retire it (no re-read/re-promote).
    if (retire && alreadyPromoted) {
      // Log the decision in BOTH modes so `compile.mjs --dry-run` surfaces the
      // planned retirement (consistent with skip-today / skip-promoted).
      appendCompileLog({ event: "retire", document: daily.name, dryRun: DRY_RUN });
      if (!DRY_RUN) {
        try {
          await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
          delete promoted[daily.name];
        } catch (err) {
          counts.error += 1;
          appendCompileLog({ event: "disable-error", document: daily.name, error: err.message || String(err) });
        }
      }
      continue;
    }

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
        if (retire) {
          // Aged out with nothing to promote: disable it.
          try {
            await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
            appendCompileLog({ event: "disable-empty", document: daily.name });
          } catch (err) {
            counts.error += 1;
            appendCompileLog({ event: "disable-error", document: daily.name, error: err.message || String(err) });
          }
        } else {
          // Within the window: keep enabled but record it (with its current
          // word_count) so we don't re-read an empty/marker-only daily on every
          // compile; if atoms are later appended, word_count changes and it is
          // re-promoted.
          promoted[daily.name] = daily.wordCount ?? null;
          appendCompileLog({ event: "skip-empty-keep-enabled", document: daily.name });
        }
      }
      continue;
    }

    let allOk = true;
    for (const atom of atoms) {
      // Defence in depth: `plan` is in ATOM_TYPES so the schema-level
      // routing table accepts it, but plans are produced exclusively by
      // the ExitPlanMode hook (upsert-by-name into the `plans` slot).
      // flush.mjs already drops `type:plan` atoms before write, but a
      // hand-edited daily could still slip one through and produce a
      // `knowledge-*.md`-named doc inside the plans slot. Drop it here
      // too so promotion can never leak.
      if (atom.type === "plan") {
        console.error(
          `compile.mjs: dropping atom with type='plan' (source='${daily.name}', title='${String(atom.title).slice(0, 40)}'); plans are written only by the ExitPlanMode hook`,
        );
        appendCompileLog({ event: "atom-skip-plan", source: daily.name, atomTitle: atom.title });
        continue;
      }
      // Quality rubric: in strict mode (MEMORY_COMPILE_QUALITY_STRICT=true)
      // atoms failing the heuristic checks are dropped before any LLM
      // round-trip. In lax mode (default) we still surface the verdict in
      // the compile log so the user can decide whether to tighten the
      // signal-density floor. The rubric is intentionally conservative:
      // false negatives here are atoms that should never have been kept.
      const quality = scoreAtomQuality(atom);
      if (!quality.ok) {
        if (QUALITY_STRICT) {
          console.error(
            `compile.mjs: dropping low-quality atom (source='${daily.name}', title='${String(atom.title).slice(0, 40)}'): ${quality.reasons.join("; ")}`,
          );
          appendCompileLog({
            event: "atom-skip-low-quality",
            source: daily.name,
            atomTitle: atom.title,
            reasons: quality.reasons,
            strict: true,
          });
          continue;
        }
        appendCompileLog({
          event: "atom-low-quality-warn",
          source: daily.name,
          atomTitle: atom.title,
          reasons: quality.reasons,
        });
      }
      const targetDataset = targetDatasetForAtom(atom);
      try {
        const candidates = await dedupCandidates(atom, targetDataset);
        const decision = await decideAction(atom, candidates, systemPrompt);
        if (!decision || typeof decision !== "object" || !decision.action) {
          throw new LLMOutputInvalid("compile decision missing 'action'", JSON.stringify(decision));
        }
        const result = await executeAction(atom, decision, candidates, targetDataset);
        counts[decision.action] = (counts[decision.action] || 0) + 1;

        let metadataResult;
        if (decision.action === "create" || decision.action === "update") {
          metadataResult = await applyMetadataToWritten(atom, result, targetDataset);
        }

        // Metadata-write failure is non-fatal for the doc itself but the
        // doc is now un-filterable. Mark the daily kept-enabled so a later
        // compile retries the metadata write. A `warning` (e.g. "no
        // fields matched") still counts as ok=true so it does NOT trip the
        // retry cap (config issue, not transient).
        const metadataFailed = metadataResult && metadataResult.ok !== true;
        const metadataWarning = metadataResult && metadataResult.ok === true && metadataResult.warning;

        if (metadataWarning && !warnedSchemaMissing.has(targetDataset)) {
          warnedSchemaMissing.add(targetDataset);
          console.error(
            `compile.mjs: WARNING: metadata schema missing on dataset '${targetDataset}'. Promoted docs are un-filterable until you run ./.memory/src/scripts/dify-setup.sh.`,
          );
        }

        // Explicit 3-state log: "ok" (clean write), "warning" (schema missing
        // on dataset; doc is un-filterable but no retry — config issue),
        // "failed" (transient/bridge error; daily kept enabled for retry).
        // undefined when no metadata was attempted (no fields to write).
        let metadataApplied;
        if (!metadataResult) metadataApplied = undefined;
        else if (metadataResult.ok === true && !metadataResult.warning) metadataApplied = "ok";
        else if (metadataResult.ok === true && metadataResult.warning) metadataApplied = "warning";
        else metadataApplied = "failed";

        appendCompileLog({
          event: "atom",
          source: daily.name,
          target: targetDataset,
          atomTitle: atom.title,
          action: decision.action,
          supersedes: decision.supersedes,
          dryRun: DRY_RUN,
          metadataApplied,
          metadataWarning: metadataWarning || undefined,
          metadataError: metadataResult?.error || metadataResult?.reason,
        });
        if (!DRY_RUN && result?.ok === false) throw new Error(JSON.stringify(result));
        if (metadataFailed) allOk = false;
      } catch (err) {
        allOk = false;
        counts.error += 1;
        appendCompileLog({
          event: "atom-error",
          source: daily.name,
          target: targetDataset,
          atomTitle: atom.title,
          error: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof DifyBridgeUnavailable || err instanceof LLMProviderUnavailable) {
          // Persist any in-memory state mutations (action counts, prior
          // dailies' retry counters) before exiting so the next compile
          // run sees the latest state.
          try { writeState(state); } catch { /* swallow — state write best-effort */ }
          console.error(`compile.mjs: aborting (${err.constructor.name}): ${err.message}`);
          process.exit(0);
        }
      }
    }

    if (allOk && !DRY_RUN) {
      promotedDocs += 1;
      // Clear any retry counter for this daily on success.
      if (state.metadata_retry?.[daily.id]) {
        delete state.metadata_retry[daily.id];
      }
      if (retire) {
        // Aged out: promoted cleanly, now retire from the active window.
        try {
          await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
          appendCompileLog({ event: "retire-after-promote", document: daily.name });
          delete promoted[daily.name];
        } catch (err) {
          counts.error += 1;
          appendCompileLog({ event: "disable-error", document: daily.name, error: err.message || String(err) });
        }
      } else {
        // Within the window: keep the raw daily enabled/searchable; record it
        // with its current word_count so it is not promoted again UNLESS a later
        // worker appends more atoms (which changes word_count -> re-promote).
        promoted[daily.name] = daily.wordCount ?? null;
        appendCompileLog({ event: "promote-keep-enabled", document: daily.name });
      }
    } else if (!allOk && !DRY_RUN) {
      // Bounded retry for metadata-write failures: after N attempts, stop
      // retrying so we don't accumulate duplicate knowledge-* docs forever.
      // Atom-level errors (LLM, network) get the same cap because we can't
      // tell them apart here. On give-up: an aged-out daily is disabled; a
      // within-window daily is kept enabled but marked promoted so it is not
      // retried (it stays searchable as raw until it ages out).
      const attempts = (state.metadata_retry?.[daily.id] || 0) + 1;
      state.metadata_retry = state.metadata_retry || {};
      state.metadata_retry[daily.id] = attempts;
      if (attempts >= METADATA_RETRY_LIMIT) {
        if (retire) {
          try {
            await disableDocument({ documentId: daily.id, datasetId: dailyDataset });
            appendCompileLog({
              event: "give-up-disable",
              document: daily.name,
              attempts,
              reason: `${attempts} consecutive failed attempts; disabling aged-out daily to avoid duplicate-create loop`,
            });
            delete promoted[daily.name];
          } catch (err) {
            appendCompileLog({ event: "give-up-disable-error", document: daily.name, error: err.message || String(err) });
          }
        } else {
          promoted[daily.name] = daily.wordCount ?? null;
          appendCompileLog({
            event: "give-up-keep-enabled",
            document: daily.name,
            attempts,
            reason: `${attempts} consecutive failed attempts; marking promoted to stop the retry loop (kept enabled, within active window)`,
          });
        }
        delete state.metadata_retry[daily.id];
      } else {
        appendCompileLog({
          event: "kept-enabled",
          document: daily.name,
          reason: `atom errors; will retry next compile (attempt ${attempts}/${METADATA_RETRY_LIMIT})`,
          attempts,
        });
      }
    }

    // Persist state per-daily so a crash mid-loop doesn't lose retry
    // counters. Without this, a process.exit(0) on bridge/LLM unavailable
    // (lines above) would never let the retry cap kick in.
    try {
      writeState(state);
    } catch (err) {
      console.error(`compile.mjs: state write failed (continuing): ${err instanceof Error ? err.message : err}`);
    }
  }

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

// Run main() only when invoked as a script, not when imported by tests.
// Mirrors the hardened isMainModule idiom in scripts/hooks/exit-plan-mode.mjs:
//   - `!process.argv[1]` guards REPL / `node -e '...'` / piped stdin where
//     argv[1] is undefined (pathToFileURL(undefined) would throw).
//   - `path.resolve(process.argv[1])` normalises a relative argv[1]
//     (`node scripts/compile.mjs`) to an absolute path before comparison,
//     so it matches the absolute `import.meta.url` regardless of how the
//     launcher passed the path.
//   - try/catch makes the guard fail closed (no main()) if pathToFileURL
//     ever throws on an exotic argv[1] shape, rather than crashing import.
// pathToFileURL handles Windows drive letters / UNC paths / percent-encoding.
const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  await main();
}
