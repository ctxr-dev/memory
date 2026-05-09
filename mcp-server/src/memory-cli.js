import fs from "node:fs";
import path from "node:path";
import {
  buildDatasetMap,
  createDataset,
  createDocumentByText,
  deleteDocument,
  disableDocument,
  fetchJsonWithTimeout,
  findDocumentByExactName,
  getConfig,
  getDocumentText,
  listAllDatasets,
  listAllDocuments,
  requireDifyWriteConfig,
  resolveDatasetId,
  upsertDocumentByName,
} from "./dify.js";
import { findFiles, defaultGlobs, defaultIgnore, relPathToDocName } from "./glob.js";

const WORKSPACE_ROOT = process.env.WORKSPACE_MOUNT || "/workspace";
const MAX_FILE_BYTES = Number.parseInt(process.env.ABSORB_MAX_FILE_BYTES || "", 10) || 500_000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function splitList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function searchCmd(config, { query, datasetId, limit }) {
  if (!query || typeof query !== "string") throw new Error("--query <string> is required");
  const datasets = datasetId
    ? [resolveDatasetId(config, datasetId) || datasetId]
    : config.datasetIds;
  if (datasets.length === 0) {
    throw new Error("No dataset configured. Set DIFY_DATASETS or pass --datasetId.");
  }
  const max = Number.parseInt(limit, 10) || config.maxResults;
  const all = [];
  for (const dsId of datasets) {
    const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(dsId)}/retrieve`;
    const payload = { query };
    if (config.retrievalModel) payload.retrieval_model = config.retrievalModel;
    const body = await fetchJsonWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      config.timeoutMs,
    );
    const records = Array.isArray(body?.records) ? body.records : [];
    for (const rec of records) {
      const seg = rec?.segment || {};
      const doc = seg.document || {};
      all.push({
        datasetId: dsId,
        score: typeof rec?.score === "number" ? rec.score : null,
        documentId: seg.document_id || doc.id || null,
        documentName: doc.name || null,
        content: seg.content || "",
      });
    }
  }
  all.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return { query, datasets, totalRecords: all.length, records: all.slice(0, max) };
}

async function writeCmd(config, { name, datasetId, supersedes, supersedesAction }) {
  if (!name) throw new Error("--name <string> is required");
  const text = (await readStdin()).trim();
  if (!text) throw new Error("No text on stdin");
  const created = await createDocumentByText(config, { datasetId, name, text });
  let supersede;
  if (supersedes) {
    const action = supersedesAction || "disable";
    supersede = action === "delete"
      ? await deleteDocument(config, { datasetId, documentId: supersedes })
      : await disableDocument(config, { datasetId, documentId: supersedes });
  }
  return {
    ok: true,
    datasetId: requireDifyWriteConfig(config, datasetId),
    name,
    created,
    supersedes: supersedes
      ? { documentId: supersedes, action: supersedesAction || "disable", result: supersede }
      : undefined,
  };
}

async function saveCmd(config, { name, datasetId }) {
  if (!name) throw new Error("--name <string> is required");
  const text = (await readStdin()).trim();
  if (!text) throw new Error("No text on stdin");
  return upsertDocumentByName(config, { datasetId, name, text });
}

async function listCmd(config, { datasetId, prefix, enabled }) {
  const docs = await listAllDocuments(config, { datasetId, keyword: prefix });
  const filtered = enabled === "true" || enabled === true
    ? docs.filter((d) => d?.enabled === true)
    : enabled === "false" || enabled === false
      ? docs.filter((d) => d?.enabled === false)
      : docs;
  return {
    datasetId: requireDifyWriteConfig(config, datasetId),
    prefix: prefix || "",
    total: filtered.length,
    documents: filtered.map((d) => ({
      id: d?.id,
      name: d?.name,
      enabled: d?.enabled,
      indexingStatus: d?.indexing_status || d?.display_status,
      createdAt: d?.created_at,
      wordCount: d?.word_count,
    })),
  };
}

async function readCmd(config, { datasetId, documentId }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  const text = await getDocumentText(config, { datasetId, documentId });
  return { datasetId: requireDifyWriteConfig(config, datasetId), documentId, text };
}

async function disableCmd(config, { datasetId, documentId }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  return disableDocument(config, { datasetId, documentId });
}

async function deleteCmd(config, { datasetId, documentId }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  return deleteDocument(config, { datasetId, documentId });
}

async function listDatasetsCmd(config) {
  const datasets = await listAllDatasets(config);
  const declared = buildDatasetMap();
  return {
    datasets: datasets.map((d) => ({
      id: d?.id,
      name: d?.name,
      description: d?.description,
      documentCount: d?.document_count,
      indexingTechnique: d?.indexing_technique,
    })),
    declaredLocally: Array.from(declared.entries()).map(([slug, entry]) => ({
      name: slug,
      configuredId: entry.id || "",
    })),
  };
}

async function createDatasetCmd(config, { name, description }) {
  if (!name) throw new Error("--name <name> is required");
  return createDataset(config, { name, description });
}

async function findByNameCmd(config, { datasetId, name }) {
  if (!name) throw new Error("--name <name> is required");
  const doc = await findDocumentByExactName(config, { datasetId, name });
  return { datasetId: requireDifyWriteConfig(config, datasetId), name, document: doc };
}

async function scanCmd(config, { include, ignore, root }) {
  const baseRoot = root || WORKSPACE_ROOT;
  if (!fs.existsSync(baseRoot)) {
    throw new Error(`Workspace root not mounted at '${baseRoot}'. Mount it via compose.mcp.yaml WORKSPACE_DIR.`);
  }
  const includeGlobs = splitList(include);
  const ignoreGlobs = splitList(ignore);
  const matches = findFiles(baseRoot, {
    include: includeGlobs.length > 0 ? includeGlobs : defaultGlobs(),
    ignore: ignoreGlobs.length > 0 ? ignoreGlobs : defaultIgnore(),
  });
  return {
    root: baseRoot,
    include: includeGlobs.length > 0 ? includeGlobs : defaultGlobs(),
    ignore: ignoreGlobs.length > 0 ? ignoreGlobs : defaultIgnore(),
    total: matches.length,
    files: matches.map((m) => ({
      relPath: m.relPath,
      docName: relPathToDocName(m.relPath),
      size: m.size,
      mtime: m.mtime,
    })),
  };
}

async function absorbCmd(config, { datasetId, files, dryRun }) {
  const fileList = splitList(files);
  if (fileList.length === 0) throw new Error("--files <comma-or-newline-separated-relpaths> is required");
  const baseRoot = WORKSPACE_ROOT;
  const dataset = requireDifyWriteConfig(config, datasetId);
  const isDryRun = dryRun === true || dryRun === "true";

  const results = [];
  for (const rel of fileList) {
    const safeRel = String(rel).replace(/^\/+/, "");
    const abs = path.join(baseRoot, safeRel);
    if (!abs.startsWith(`${baseRoot}/`) && abs !== baseRoot) {
      results.push({ relPath: rel, ok: false, error: "path escapes workspace mount" });
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      results.push({ relPath: rel, ok: false, error: `stat failed: ${err.message}` });
      continue;
    }
    if (!stat.isFile()) {
      results.push({ relPath: rel, ok: false, error: "not a file" });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      results.push({ relPath: rel, ok: false, error: `file ${stat.size}B exceeds ABSORB_MAX_FILE_BYTES=${MAX_FILE_BYTES}` });
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    const docName = relPathToDocName(safeRel);
    if (isDryRun) {
      results.push({ relPath: rel, ok: true, dryRun: true, docName, size: stat.size });
      continue;
    }
    try {
      const out = await upsertDocumentByName(config, { datasetId: dataset, name: docName, text });
      results.push({ relPath: rel, ok: true, docName, replacedId: out.replacedId, size: stat.size });
    } catch (err) {
      results.push({ relPath: rel, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    datasetId: dataset,
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

const args = parseArgs(process.argv.slice(2));
const sub = args._[0];

try {
  const config = getConfig();
  let result;
  switch (sub) {
    case "search": result = await searchCmd(config, args); break;
    case "write": result = await writeCmd(config, args); break;
    case "save": result = await saveCmd(config, args); break;
    case "list": result = await listCmd(config, args); break;
    case "read": result = await readCmd(config, args); break;
    case "disable": result = await disableCmd(config, args); break;
    case "delete": result = await deleteCmd(config, args); break;
    case "list-datasets": result = await listDatasetsCmd(config); break;
    case "create-dataset": result = await createDatasetCmd(config, args); break;
    case "find-by-name": result = await findByNameCmd(config, args); break;
    case "scan": result = await scanCmd(config, args); break;
    case "absorb": result = await absorbCmd(config, args); break;
    default:
      console.error(`Unknown subcommand: ${sub || "(none)"}`);
      console.error(
        "Usage: memory-cli.js <search|write|save|list|read|disable|delete|list-datasets|create-dataset|find-by-name|scan|absorb> [--flag value]",
      );
      process.exit(2);
  }
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
