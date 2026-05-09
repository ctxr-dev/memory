import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
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
  listAllDatasets,
  maskSecret,
  requireDifyWriteConfig,
  resolveDatasetId,
  upsertDocumentByName,
} from "./dify.js";
import { findFiles, defaultGlobs, defaultIgnore, relPathToDocName } from "./glob.js";

const WORKSPACE_MOUNT = process.env.WORKSPACE_MOUNT || "/workspace";
const ABSORB_MAX_FILE_BYTES = Number.parseInt(process.env.ABSORB_MAX_FILE_BYTES || "", 10) || 500_000;

async function retrieveDataset({ apiUrl, apiKey, retrievalModel, timeoutMs }, datasetId, query) {
  const endpoint = `${apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(datasetId)}/retrieve`;
  const payload = { query };

  if (retrievalModel) {
    payload.retrieval_model = retrievalModel;
  }

  const body = await fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );

  return Array.isArray(body?.records) ? body.records : [];
}

function compactRecord(datasetId, record) {
  const segment = record?.segment || {};
  const document = segment.document || {};

  return {
    datasetId,
    score: typeof record?.score === "number" ? record.score : null,
    segmentId: segment.id || null,
    documentId: segment.document_id || document.id || null,
    documentName: document.name || null,
    position: typeof segment.position === "number" ? segment.position : null,
    status: segment.status || null,
    enabled: typeof segment.enabled === "boolean" ? segment.enabled : null,
    keywords: Array.isArray(segment.keywords) ? segment.keywords : [],
    wordCount: typeof segment.word_count === "number" ? segment.word_count : null,
    content: segment.content || "",
  };
}

function jsonToolResponse(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorToolResponse(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

const server = new McpServer({
  name: "__MEMORY_SERVER_NAME__",
  version: "0.1.0",
});

server.registerTool(
  "get_memory_config",
  {
    title: "Get memory configuration",
    description: "Inspect the Dify memory bridge configuration without exposing secrets.",
    inputSchema: {},
  },
  async () => {
    try {
      const config = getConfig();
      return jsonToolResponse({
        apiUrl: config.apiUrl,
        apiKeyConfigured: Boolean(config.apiKey),
        apiKeyPreview: maskSecret(config.apiKey),
        datasetIds: config.datasetIds,
        writeDatasetId: config.writeDatasetId || config.datasetIds[0] || "",
        sessionProcessRulePreset: config.sessionProcessRulePreset,
        sessionProcessRuleConfigured: Boolean(config.sessionProcessRule),
        retrievalModelConfigured: Boolean(config.retrievalModel),
        maxResults: config.maxResults,
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "search_memory",
  {
    title: "Search project memory",
    description:
      "Search configured Dify knowledge bases and return scored chunks with document metadata.",
    inputSchema: {
      query: z.string().trim().min(1).max(250),
      datasetIds: z.array(z.string().trim().min(1)).optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, datasetIds, maxResults }) => {
    try {
      const config = getConfig();
      const selectedDatasetIds = Array.isArray(datasetIds) && datasetIds.length > 0
        ? datasetIds
        : config.datasetIds;

      if (!config.apiKey) {
        throw new Error("DIFY_KNOWLEDGE_API_KEY is not configured in memory/.env.");
      }
      if (selectedDatasetIds.length === 0) {
        throw new Error("DIFY_DATASET_IDS is empty. Add at least one Dify knowledge base ID.");
      }

      const settled = await Promise.allSettled(
        selectedDatasetIds.map(async (datasetId) => {
          const records = await retrieveDataset(config, datasetId, query);
          return records.map((record) => compactRecord(datasetId, record));
        }),
      );

      const errors = [];
      const records = [];

      settled.forEach((result, index) => {
        if (result.status === "fulfilled") {
          records.push(...result.value);
        } else {
          errors.push({
            datasetId: selectedDatasetIds[index],
            message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });

      const limit = maxResults || config.maxResults;
      records.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));

      return jsonToolResponse({
        query,
        datasetsSearched: selectedDatasetIds,
        errors,
        totalRecords: records.length,
        records: records.slice(0, limit),
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "write_memory",
  {
    title: "Write project memory",
    description:
      "Create a Dify knowledge document from concise project memory text such as decisions, constraints, and session summaries. Optionally supersede an existing document by passing its id; the old document is disabled (or deleted with supersedesAction='delete') after the new one is written.",
    inputSchema: {
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(20).max(200_000),
      datasetId: z.string().trim().min(1).optional(),
      supersedes: z.string().trim().min(1).optional(),
      supersedesAction: z.enum(["disable", "delete"]).optional(),
    },
  },
  async ({ name, text, datasetId, supersedes, supersedesAction }) => {
    try {
      const config = getConfig();
      const response = await createDocumentByText(config, { datasetId, name, text });

      let supersedeResult;
      if (supersedes) {
        const action = supersedesAction || "disable";
        try {
          supersedeResult = action === "delete"
            ? await deleteDocument(config, { datasetId, documentId: supersedes })
            : await disableDocument(config, { datasetId, documentId: supersedes });
        } catch (err) {
          supersedeResult = {
            ok: false,
            action,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      return jsonToolResponse({
        ok: true,
        datasetId: requireDifyWriteConfig(config, datasetId),
        response,
        supersedes: supersedes
          ? {
              documentId: supersedes,
              action: supersedesAction || "disable",
              result: supersedeResult,
            }
          : undefined,
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "update_memory",
  {
    title: "Update an existing project memory document",
    description:
      "Replace an existing Dify knowledge document with a merged version. Equivalent to write_memory with a required supersedes id; provided as a dedicated tool so dedup-merge callers (compile.mjs) have an unambiguous signal.",
    inputSchema: {
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(20).max(200_000),
      supersedes: z.string().trim().min(1),
      datasetId: z.string().trim().min(1).optional(),
      supersedesAction: z.enum(["disable", "delete"]).optional(),
    },
  },
  async ({ name, text, supersedes, datasetId, supersedesAction }) => {
    try {
      const config = getConfig();
      const created = await createDocumentByText(config, { datasetId, name, text });
      const action = supersedesAction || "disable";
      const supersedeResult = action === "delete"
        ? await deleteDocument(config, { datasetId, documentId: supersedes })
        : await disableDocument(config, { datasetId, documentId: supersedes });
      return jsonToolResponse({
        ok: true,
        datasetId: requireDifyWriteConfig(config, datasetId),
        created,
        supersedes: { documentId: supersedes, action, result: supersedeResult },
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "list_datasets",
  {
    title: "List Dify datasets",
    description:
      "List every Dify Knowledge dataset visible to the configured API key, plus the local DIFY_DATASETS bindings declared in memory/.env (so you can see which named slot points to which dataset id).",
    inputSchema: {},
  },
  async () => {
    try {
      const config = getConfig();
      const remote = await listAllDatasets(config);
      const declared = buildDatasetMap();
      return jsonToolResponse({
        datasets: remote.map((d) => ({
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
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "create_dataset",
  {
    title: "Create a Dify dataset",
    description:
      "Create a new Dify Knowledge dataset. Returns the new dataset id; the user (or dify-setup.sh) must then bind it to a name in memory/.env (DIFY_DATASETS=daily,knowledge,plans,investigations + DIFY_DATASET_<NAME>_ID=<id>).",
    inputSchema: {
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional(),
    },
  },
  async ({ name, description }) => {
    try {
      const config = getConfig();
      const created = await createDataset(config, { name, description });
      return jsonToolResponse({ ok: true, dataset: created });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "save_to_dataset",
  {
    title: "Upsert a document into a named dataset",
    description:
      "Write `text` as a Dify document with the given exact `name`, replacing any existing document in the dataset that has the same name. Use this for plans, investigations, and any artefact whose identity is its filename. The `dataset` argument can be a configured slot name (e.g. 'plans', 'investigations') or a raw dataset id.",
    inputSchema: {
      dataset: z.string().trim().min(1),
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(1).max(500_000),
    },
  },
  async ({ dataset, name, text }) => {
    try {
      const config = getConfig();
      const result = await upsertDocumentByName(config, { datasetId: dataset, name, text });
      return jsonToolResponse({ ok: true, ...result });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "scan_documents",
  {
    title: "Scan workspace files for absorption candidates",
    description:
      "Walk the read-only /workspace mount inside the bridge container and return matching files with their suggested doc names (relative path with '/' replaced by '_'). Default include globs cover .md/.mdx/.markdown/.txt/.rst/.adoc; default ignore covers .git, node_modules, vendor, .memory, dist, build. Pass `include` or `ignore` arrays to override.",
    inputSchema: {
      include: z.array(z.string().trim().min(1)).optional(),
      ignore: z.array(z.string().trim().min(1)).optional(),
    },
  },
  async ({ include, ignore }) => {
    try {
      if (!fs.existsSync(WORKSPACE_MOUNT)) {
        throw new Error(
          `Workspace mount '${WORKSPACE_MOUNT}' missing. Recreate the bridge container after pulling the latest compose.mcp.yaml so the workspace volume is mounted.`,
        );
      }
      const matches = findFiles(WORKSPACE_MOUNT, {
        include: include && include.length > 0 ? include : defaultGlobs(),
        ignore: ignore && ignore.length > 0 ? ignore : defaultIgnore(),
      });
      return jsonToolResponse({
        root: WORKSPACE_MOUNT,
        include: include && include.length > 0 ? include : defaultGlobs(),
        ignore: ignore && ignore.length > 0 ? ignore : defaultIgnore(),
        total: matches.length,
        files: matches.map((m) => ({
          relPath: m.relPath,
          docName: relPathToDocName(m.relPath),
          size: m.size,
          mtime: m.mtime,
        })),
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "absorb_files",
  {
    title: "Absorb selected workspace files into a dataset",
    description:
      "Read each file (relative path under /workspace) and upsert it as a Dify document using its relative path with '/' replaced by '_' as the document name. Existing documents with the same name are replaced. `dataset` is a configured slot name or raw id (defaults to DIFY_ABSORB_DEFAULT_DATASET, normally 'knowledge'). Pass dryRun=true to see what would happen without writing.",
    inputSchema: {
      files: z.array(z.string().trim().min(1)).min(1),
      dataset: z.string().trim().min(1).optional(),
      dryRun: z.boolean().optional(),
    },
  },
  async ({ files, dataset, dryRun }) => {
    try {
      const config = getConfig();
      const datasetSlot = dataset || config.absorbDefaultDatasetName;
      const datasetId = requireDifyWriteConfig(config, datasetSlot);
      if (!fs.existsSync(WORKSPACE_MOUNT)) {
        throw new Error(`Workspace mount '${WORKSPACE_MOUNT}' missing.`);
      }
      const results = [];
      for (const rel of files) {
        const safeRel = String(rel).replace(/^\/+/, "");
        const abs = path.join(WORKSPACE_MOUNT, safeRel);
        if (!abs.startsWith(`${WORKSPACE_MOUNT}/`) && abs !== WORKSPACE_MOUNT) {
          results.push({ relPath: rel, ok: false, error: "path escapes workspace mount" });
          continue;
        }
        let stat;
        try { stat = fs.statSync(abs); } catch (err) {
          results.push({ relPath: rel, ok: false, error: `stat failed: ${err.message}` });
          continue;
        }
        if (!stat.isFile()) {
          results.push({ relPath: rel, ok: false, error: "not a file" });
          continue;
        }
        if (stat.size > ABSORB_MAX_FILE_BYTES) {
          results.push({ relPath: rel, ok: false, error: `file ${stat.size}B exceeds ABSORB_MAX_FILE_BYTES=${ABSORB_MAX_FILE_BYTES}` });
          continue;
        }
        const text = fs.readFileSync(abs, "utf8");
        const docName = relPathToDocName(safeRel);
        if (dryRun) {
          results.push({ relPath: rel, ok: true, dryRun: true, docName, size: stat.size });
          continue;
        }
        try {
          const out = await upsertDocumentByName(config, { datasetId, name: docName, text });
          results.push({ relPath: rel, ok: true, docName, replacedId: out.replacedId, size: stat.size });
        } catch (err) {
          results.push({ relPath: rel, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return jsonToolResponse({
        datasetId,
        datasetSlot,
        total: results.length,
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
