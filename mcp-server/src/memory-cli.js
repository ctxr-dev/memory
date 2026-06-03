import fs from "node:fs";
import path from "node:path";
import {
  buildDatasetMap,
  buildMetadataCondition,
  createDataset,
  createDatasetMetadataField,
  createDocumentByText,
  deleteDocument,
  disableDocument,
  enableDocument,
  fetchJsonWithTimeout,
  findDocumentByExactName,
  getConfig,
  getDatasetInfo,
  getDefaultEmbeddingModel,
  getDocumentText,
  listAllDatasets,
  listAllDocuments,
  listDatasetMetadataFields,
  requireDifyWriteConfig,
  resolveDatasetId,
  retrieveChunks,
  setBuiltInMetadata,
  updateDocumentMetadata,
  upsertDocumentByName,
} from "./dify.js";
import { findFiles, defaultGlobs, defaultIgnore, relPathToDocName } from "./glob.js";
import { WORKSPACE_MOUNT as WORKSPACE_ROOT, ABSORB_MAX_FILE_BYTES as MAX_FILE_BYTES } from "./workspace.js";

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

function parseJsonFlag(raw, fieldName) {
  if (raw == null || raw === "" || raw === true) return null;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    throw new Error(`--${fieldName} must be valid JSON: ${err.message}`);
  }
}

async function searchCmd(config, { query, datasetId, limit, filters, scoreThreshold }) {
  if (!query || typeof query !== "string") throw new Error("--query <string> is required");
  const datasets = datasetId
    ? [resolveDatasetId(config, datasetId) || datasetId]
    : config.datasetIds;
  if (datasets.length === 0) {
    throw new Error("No dataset configured. Run ./.memory/src/scripts/dify-setup.sh or pass --datasetId.");
  }
  const max = Number.parseInt(limit, 10) || config.maxResults;
  const filterObj = parseJsonFlag(filters, "filters");
  const metadataCondition = filterObj ? buildMetadataCondition(filterObj) : null;
  const threshold =
    scoreThreshold == null || scoreThreshold === true
      ? undefined
      : Number.parseFloat(String(scoreThreshold));

  const all = [];
  const errors = [];
  for (const dsId of datasets) {
    try {
      const records = await retrieveChunks(config, {
        datasetId: dsId,
        query,
        metadataCondition,
        scoreThreshold: Number.isFinite(threshold) ? threshold : undefined,
        topK: max,
      });
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
    } catch (err) {
      errors.push({ datasetId: dsId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  all.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return {
    query,
    datasets,
    metadataCondition,
    scoreThreshold: Number.isFinite(threshold) ? threshold : null,
    errors,
    totalRecords: all.length,
    records: all.slice(0, max),
  };
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

async function saveCmd(config, { name, datasetId, metadata }) {
  if (!name) throw new Error("--name <string> is required");
  const text = (await readStdin()).trim();
  if (!text) throw new Error("No text on stdin");
  const md = parseJsonFlag(metadata, "metadata");
  return upsertDocumentByName(config, { datasetId, name, text, metadata: md });
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

// Flatten Dify's doc_metadata array ([{name,value,type}]) into a key->value map.
function flattenDocMetadata(doc) {
  const md = {};
  const fields = Array.isArray(doc?.doc_metadata) ? doc.doc_metadata : [];
  for (const f of fields) {
    if (f?.name) md[f.name] = f.value;
  }
  return md;
}

// Consolidate working-set listing: EVERY document in a dataset (enabled and
// disabled) with its flattened per-doc metadata + created_at + enabled flag.
// The plain `list` subcommand omits metadata, which the consolidate
// orchestrator needs (atom_type / error_pattern / stale / created_at) to group
// and age documents. Bodies are NOT included (fetched lazily per surviving
// candidate via `read`). One paginated listAllDocuments call carries doc_metadata.
async function listConsolidateCmd(config, { datasetId }) {
  const docs = await listAllDocuments(config, { datasetId });
  return {
    datasetId: requireDifyWriteConfig(config, datasetId),
    total: docs.length,
    documents: docs.map((d) => ({
      documentId: d?.id,
      name: d?.name,
      enabled: d?.enabled,
      createdAt: d?.created_at,
      wordCount: d?.word_count,
      metadata: flattenDocMetadata(d),
    })),
  };
}

async function disableCmd(config, { datasetId, documentId }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  return disableDocument(config, { datasetId, documentId });
}

async function enableCmd(config, { datasetId, documentId }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  return enableDocument(config, { datasetId, documentId });
}

async function listMetadataFieldsCmd(config, { datasetId }) {
  return listDatasetMetadataFields(config, { datasetId });
}

// Returns a compact view of the bridge container's effective config so
// host-side wizards (./.memory/src/scripts/dify-setup.sh) can detect stale-bridge-env: the host
// .env may have the API key but the running container loaded its env at
// start time and won't see edits until a restart. apiKeyConfigured = true
// means the BRIDGE sees a non-empty key — which is what matters for
// every Dify call. Never echoes the key itself; only a 4-char preview.
async function getConfigCmd(config) {
  const apiKey = config.apiKey || "";
  const preview = apiKey.length >= 8
    ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`
    : (apiKey ? "***" : "");
  return {
    apiUrl: config.apiUrl,
    apiKeyConfigured: Boolean(apiKey),
    apiKeyPreview: preview,
    datasetIds: config.datasetIds,
    flushDataset: config.flushDatasetName,
    compileDataset: config.compileDatasetName,
    absorbDefaultDataset: config.absorbDefaultDatasetName,
    // Embedding model + provider are auto-discovered from the Dify
    // tenant on first use (mcp-server/src/dify.js::getDefaultEmbeddingModel).
    // Not echoed here because it would imply a config path that doesn't
    // exist; use `list-embedding-models` to see what the tenant has.
  };
}

// Pre-flight for ./.memory/src/scripts/dify-setup.sh: does the Dify tenant have ANY embedding
// model usable for `high_quality` + `hybrid_search`? If `data` is empty,
// every dataset create with that retrieval mode fails with the cryptic
// "Default model not found for text-embedding". The wizard should hard-
// fail before even trying, with a clear UI walkthrough.
async function listEmbeddingModelsCmd(config) {
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/workspaces/current/models/model-types/text-embedding`;
  const body = await fetchJsonWithTimeout(
    endpoint,
    { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } },
    config.timeoutMs,
  );
  const list = Array.isArray(body?.data) ? body.data : [];
  return {
    endpoint,
    count: list.length,
    providers: list.map((p) => ({
      provider: p?.provider,
      label: p?.label?.en_US || p?.label?.zh_Hans || p?.provider,
      status: p?.status,
      modelCount: Array.isArray(p?.models) ? p.models.length : 0,
      modelNames: Array.isArray(p?.models) ? p.models.map((m) => m?.model).filter(Boolean) : [],
    })),
  };
}

// Report the embedding model actually IN USE by memory: read it from the
// compile (knowledge) dataset, which is what memory writes to and searches.
// The tenant System Default can't be read via the dataset Service API, and a
// bound dataset is the authoritative answer to "what model is my memory on".
// Fall back to the tenant-list guess (clearly labelled "tenant_guess") only
// when no compile dataset is bound yet. The settings snapshot records this.
async function getEmbeddingDefaultCmd(config) {
  // resolveDatasetId is null-safe (returns an empty string on failure, never
  // throws). If a compile dataset IS bound, it is the authoritative answer.
  const datasetId = resolveDatasetId(config, config.compileDatasetName) || "";
  if (datasetId) {
    // The compile dataset is bound, so DON'T silently fall back to a tenant
    // guess if the GET fails — that would mask a broken/stale binding and let
    // the snapshot record a misleading model. Surface the failure instead.
    try {
      const info = await getDatasetInfo(config, { datasetId });
      return {
        provider: info?.embedding_model_provider || "",
        model: info?.embedding_model || "",
        source: "compile_dataset",
        datasetId,
      };
    } catch (err) {
      return {
        provider: "",
        model: "",
        source: "compile_dataset_unreachable",
        datasetId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // No compile dataset bound yet: best-effort tenant guess (clearly labelled).
  const resolved = await getDefaultEmbeddingModel(config);
  return {
    provider: resolved.provider || "",
    model: resolved.model || "",
    source: resolved.source ? `tenant_guess:${resolved.source}` : "tenant_guess",
    ...(resolved.error ? { error: resolved.error } : {}),
  };
}

async function createMetadataFieldCmd(config, { datasetId, name, type }) {
  if (!name) throw new Error("--name <field-name> is required");
  return createDatasetMetadataField(config, {
    datasetId,
    name,
    type: type || "string",
  });
}

async function setBuiltInMetadataCmd(config, { datasetId, enabled }) {
  const want = enabled === "false" || enabled === false ? false : true;
  return setBuiltInMetadata(config, { datasetId, enabled: want });
}

async function updateDocMetadataCmd(config, { datasetId, documentId, metadata }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  const md = parseJsonFlag(metadata, "metadata");
  if (!md) throw new Error("--metadata <json-object> is required");
  return updateDocumentMetadata(config, { datasetId, documentId, metadataMap: md });
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
  // Pass only caller-supplied extras; findFiles already merges with defaultIgnore() internally.
  const matches = findFiles(baseRoot, {
    include: includeGlobs.length > 0 ? includeGlobs : defaultGlobs(),
    ignore: ignoreGlobs,
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
    case "list-consolidate": result = await listConsolidateCmd(config, args); break;
    case "read": result = await readCmd(config, args); break;
    case "disable": result = await disableCmd(config, args); break;
    case "enable": result = await enableCmd(config, args); break;
    case "delete": result = await deleteCmd(config, args); break;
    case "list-datasets": result = await listDatasetsCmd(config); break;
    case "create-dataset": result = await createDatasetCmd(config, args); break;
    case "get-config": result = await getConfigCmd(config); break;
    case "list-embedding-models": result = await listEmbeddingModelsCmd(config); break;
    case "get-embedding-default": result = await getEmbeddingDefaultCmd(config); break;
    case "find-by-name": result = await findByNameCmd(config, args); break;
    case "scan": result = await scanCmd(config, args); break;
    case "absorb": result = await absorbCmd(config, args); break;
    case "list-metadata-fields": result = await listMetadataFieldsCmd(config, args); break;
    case "create-metadata-field": result = await createMetadataFieldCmd(config, args); break;
    case "set-built-in-metadata": result = await setBuiltInMetadataCmd(config, args); break;
    case "update-doc-metadata": result = await updateDocMetadataCmd(config, args); break;
    default:
      console.error(`Unknown subcommand: ${sub || "(none)"}`);
      console.error(
        "Usage: memory-cli.js <search|write|save|list|list-consolidate|read|disable|enable|delete|list-datasets|create-dataset|get-config|list-embedding-models|get-embedding-default|find-by-name|scan|absorb|list-metadata-fields|create-metadata-field|set-built-in-metadata|update-doc-metadata> [--flag value]",
      );
      process.exit(2);
  }
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
