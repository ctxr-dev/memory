import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createDocumentByText,
  fetchJsonWithTimeout,
  getConfig,
  maskSecret,
} from "./dify.js";

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
      "Create a Dify knowledge document from concise project memory text such as decisions, constraints, and session summaries.",
    inputSchema: {
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(20).max(200_000),
      datasetId: z.string().trim().min(1).optional(),
    },
  },
  async ({ name, text, datasetId }) => {
    try {
      const config = getConfig();
      const response = await createDocumentByText(config, { datasetId, name, text });
      return jsonToolResponse({
        ok: true,
        datasetId: datasetId || config.writeDatasetId || config.datasetIds[0],
        response,
      });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
