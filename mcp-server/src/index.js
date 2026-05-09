import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  buildDatasetMap,
  buildMetadataCondition,
  createDataset,
  createDocumentByText,
  deleteDocument,
  disableDocument,
  getConfig,
  listAllDatasets,
  maskSecret,
  requireDifyWriteConfig,
  resolveDatasetId,
  retrieveChunks,
  upsertDocumentByName,
} from "./dify.js";
import { findFiles, defaultGlobs, mergeIgnore, relPathToDocName } from "./glob.js";
import { lessonDocName } from "./slug.js";

const WORKSPACE_MOUNT = process.env.WORKSPACE_MOUNT || "/workspace";
const ABSORB_MAX_FILE_BYTES = Number.parseInt(process.env.ABSORB_MAX_FILE_BYTES || "", 10) || 500_000;

const FilterSchema = z.object({
  atom_type: z.string().trim().min(1).optional(),
  project_module: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
  task_type: z.string().trim().min(1).optional(),
  error_pattern: z.string().trim().min(1).optional(),
  tags: z.string().trim().min(1).optional(),
});

const MetadataSchema = z.object({
  atom_type: z.string().optional(),
  tags: z.string().optional(),
  project_module: z.string().optional(),
  language: z.string().optional(),
  task_type: z.string().optional(),
  error_pattern: z.string().optional(),
}).partial();

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

// MCP server identity comes from the container env (compose.mcp.yaml's
// env_file forwards memory/.env). The literal placeholder is only ever
// seen if the container was started without the env file — surface that
// as the tool-name so the misconfig is loud instead of silent.
const server = new McpServer({
  name: process.env.MCP_CONTAINER_NAME || "memory-mcp",
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
        flushDataset: config.flushDatasetName,
        compileDataset: config.compileDatasetName,
        absorbDefaultDataset: config.absorbDefaultDatasetName,
        datasetSlots: Array.from(config.datasetMap.entries()).map(([name, e]) => ({
          name,
          configuredId: e.id || "",
        })),
        legacyWriteDatasetId: config.legacyWriteDatasetId || "",
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
      "Search configured Dify knowledge bases and return scored chunks. Pass `filters` (atom_type, project_module, language, task_type, error_pattern, tags) to apply Dify-side metadata filtering BEFORE embedding rank — this is the precise, context-efficient path that avoids loading every historical record. Pass `scoreThreshold` (0..1) to drop low-similarity hits. `datasets` accepts slot names (e.g. 'self_improvement') OR raw uuids; default searches every configured slot.",
    inputSchema: {
      query: z.string().trim().min(1).max(250),
      datasets: z.array(z.string().trim().min(1)).optional(),
      datasetIds: z.array(z.string().trim().min(1)).optional(),
      filters: FilterSchema.optional(),
      scoreThreshold: z.number().min(0).max(1).optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, datasets, datasetIds, filters, scoreThreshold, maxResults }) => {
    try {
      const config = getConfig();
      const requested = Array.isArray(datasets) && datasets.length > 0
        ? datasets
        : (Array.isArray(datasetIds) && datasetIds.length > 0 ? datasetIds : null);
      const selectedDatasetIds = requested
        ? requested.map((d) => resolveDatasetId(config, d) || d).filter(Boolean)
        : config.datasetIds;

      if (!config.apiKey) {
        throw new Error("DIFY_KNOWLEDGE_API_KEY is not configured in memory/.env.");
      }
      if (selectedDatasetIds.length === 0) {
        throw new Error(
          "No datasets to search. Bind at least one slot via DIFY_DATASET_<NAME>_ID (run ./memory/scripts/dify-setup.sh) or pass `datasets` explicitly.",
        );
      }

      const metadataCondition = filters ? buildMetadataCondition(filters) : null;

      const limit = maxResults || config.maxResults;
      const settled = await Promise.allSettled(
        selectedDatasetIds.map(async (datasetId) => {
          const records = await retrieveChunks(config, {
            datasetId,
            query,
            metadataCondition,
            scoreThreshold,
            topK: limit,
          });
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

      records.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));

      return jsonToolResponse({
        query,
        datasetsSearched: selectedDatasetIds,
        filters: filters || null,
        scoreThreshold: scoreThreshold ?? null,
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
      "List every Dify Knowledge dataset visible to the configured API key, plus the local slot bindings declared by DIFY_DATASET_<NAME>_ID lines in memory/.env (so you can see which named slot points to which dataset id).",
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
      "Create a new Dify Knowledge dataset (high_quality + hybrid_search by default). Returns the new dataset id; the user (or dify-setup.sh) must then bind it to a name in memory/.env by adding a DIFY_DATASET_<NAME>_ID=<id> line.",
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
      "Write `text` as a Dify document with the given exact `name`, replacing any existing document in the dataset that has the same name. Use this for plans, investigations, and any artefact whose identity is its filename. The `dataset` argument can be a configured slot name (e.g. 'plans', 'investigations') or a raw dataset id. Optional `metadata` map applies the per-document Dify metadata fields (atom_type, project_module, language, task_type, error_pattern, tags) so the doc is filterable in future search_memory / recall_lessons calls.",
    inputSchema: {
      dataset: z.string().trim().min(1),
      name: z.string().trim().min(1).max(180),
      text: z.string().trim().min(1).max(500_000),
      metadata: MetadataSchema.optional(),
    },
  },
  async ({ dataset, name, text, metadata }) => {
    try {
      const config = getConfig();
      const result = await upsertDocumentByName(config, { datasetId: dataset, name, text, metadata });
      return jsonToolResponse({ ok: true, ...result });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "save_lesson",
  {
    title: "Save a self-improvement lesson",
    description:
      "Persist a self-improvement lesson into the `self_improvement` slot bound via DIFY_DATASET_SELF_IMPROVEMENT_ID. Hard-fails if that slot is not configured (no fallback — a lesson in any other slot is invisible to recall_lessons). Use MID-SESSION the moment the user corrects you so the next turn can retrieve it. Doc name `lesson-<slug>-<ts>.md` (slug from `title`); same title overwrites in place. `metadata.project_module`, `metadata.task_type`, and `metadata.error_pattern` are required.",
    inputSchema: {
      title: z.string().trim().min(1).max(180),
      body: z.string().trim().min(1).max(10_000),
      metadata: z.object({
        project_module: z.string().trim().min(1),
        task_type: z.string().trim().min(1),
        error_pattern: z.string().trim().min(1),
        language: z.string().trim().optional(),
        tags: z.string().trim().optional(),
      }),
      tags: z.array(z.string().trim().min(1)).optional(),
      evidence: z.string().trim().max(500).optional(),
    },
  },
  async ({ title, body, metadata, tags, evidence }) => {
    try {
      const config = getConfig();
      // self_improvement is the only correct destination — falling back to
      // knowledge would write a lesson where recall_lessons can't find it.
      // Hard-fail with a clear error instead.
      const lessonId = config.datasetMap.get("self_improvement")?.id;
      if (!lessonId) {
        throw new Error(
          "save_lesson: self_improvement dataset is not configured. Set DIFY_DATASET_SELF_IMPROVEMENT_ID in memory/.env (or run ./memory/scripts/dify-setup.sh).",
        );
      }
      const datasetSlot = "self_improvement";
      const name = lessonDocName(title);
      const tagList = Array.isArray(tags) ? tags : (metadata.tags ? String(metadata.tags).split(",").map((t) => t.trim()).filter(Boolean) : []);
      // Body lines: skip optional fields when empty so the rendered doc
      // matches what compile produces and parseAtomsFromMarkdown reads.
      const lines = [
        `# ${title}`,
        "",
        `- type: self-improvement-lesson`,
      ];
      if (tagList.length > 0) lines.push(`- tags: [${tagList.join(", ")}]`);
      lines.push(`- project_module: ${metadata.project_module}`);
      if (metadata.language) lines.push(`- language: ${metadata.language}`);
      lines.push(`- task_type: ${metadata.task_type}`);
      lines.push(`- error_pattern: ${metadata.error_pattern}`);
      lines.push(`- updated_at_utc: ${new Date().toISOString()}`);
      lines.push("", body);
      if (evidence) lines.push("", `evidence: ${evidence}`);
      const text = `${lines.join("\n")}\n`;

      // Build the per-document metadata map; OMIT empty fields so Dify
      // treats them as absent rather than `is ""` matchable.
      const fullMetadata = { atom_type: "self-improvement-lesson" };
      if (tagList.length > 0) fullMetadata.tags = tagList.join(",");
      if (metadata.project_module) fullMetadata.project_module = metadata.project_module;
      if (metadata.language) fullMetadata.language = metadata.language;
      if (metadata.task_type) fullMetadata.task_type = metadata.task_type;
      if (metadata.error_pattern) fullMetadata.error_pattern = metadata.error_pattern;

      const result = await upsertDocumentByName(config, {
        datasetId: datasetSlot,
        name,
        text,
        metadata: fullMetadata,
      });
      return jsonToolResponse({ ok: true, datasetSlot, ...result });
    } catch (error) {
      return errorToolResponse(error);
    }
  },
);

server.registerTool(
  "recall_lessons",
  {
    title: "Recall relevant self-improvement lessons before related work",
    description:
      "BEFORE starting a non-trivial task, call this with the inferred task context (`project_module`, `language`, `task_type`, optional `error_pattern`). Searches the `self_improvement` Dify dataset with metadata filters first; broadens fall-back when fewer than 3 hits by dropping `error_pattern`, then `language`, then `task_type`. Optionally also pulls `bug-root-cause` + `feedback-rule` atoms from the `knowledge` dataset matching `project_module`. Returns at most `maxResults` (default 5) compact records sorted by score.",
    inputSchema: {
      query: z.string().trim().min(1).max(250),
      project_module: z.string().trim().min(1).optional(),
      language: z.string().trim().min(1).optional(),
      task_type: z.string().trim().min(1).optional(),
      error_pattern: z.string().trim().min(1).optional(),
      tags: z.string().trim().min(1).optional(),
      includeKnowledge: z.boolean().optional(),
      scoreThreshold: z.number().min(0).max(1).optional(),
      maxResults: z.number().int().min(1).max(20).optional(),
    },
  },
  async ({ query, project_module, language, task_type, error_pattern, tags, includeKnowledge, scoreThreshold, maxResults }) => {
    try {
      const config = getConfig();
      const lessonSlot = config.datasetMap.get("self_improvement")?.id ? "self_improvement" : null;
      if (!lessonSlot) {
        throw new Error(
          "self_improvement dataset is not configured. Set DIFY_DATASET_SELF_IMPROVEMENT_ID in memory/.env (or run ./memory/scripts/dify-setup.sh).",
        );
      }
      const limit = maxResults || 5;
      const threshold = scoreThreshold ?? 0.55;
      const lessonDatasetId = resolveDatasetId(config, lessonSlot);

      const baseFilters = {
        atom_type: "self-improvement-lesson",
        ...(project_module ? { project_module } : {}),
        ...(language ? { language } : {}),
        ...(task_type ? { task_type } : {}),
        ...(error_pattern ? { error_pattern } : {}),
        ...(tags ? { tags } : {}),
      };

      // Fall-back ladder: drop the most-specific filter first, broadening
      // step by step. Each step's filter set is built fresh from baseFilters
      // by removing the listed keys. Steps whose key is not present in
      // baseFilters become identical to the previous step and are
      // deduplicated below. We deliberately STOP after task_type — the
      // documented contract is "broaden by dropping error_pattern, then
      // language, then task_type". project_module and tags are scoping
      // signals the caller actively chose; dropping them would leak
      // unrelated lessons into the result. Final rung keeps
      // {atom_type, project_module?, tags?} only.
      const dropOrder = ["error_pattern", "language", "task_type"];
      const ladderRaw = [{ ...baseFilters }];
      const dropped = [];
      for (const key of dropOrder) {
        dropped.push(key);
        const next = { ...baseFilters };
        for (const k of dropped) delete next[k];
        ladderRaw.push(next);
      }
      // Dedup adjacent identical filter sets so we don't run the same
      // Dify call twice when the caller skipped a field.
      const ladder = [];
      let prevKey = null;
      for (const f of ladderRaw) {
        const key = JSON.stringify(f);
        if (key !== prevKey) ladder.push(f);
        prevKey = key;
      }

      // Accumulate hits across rungs. Strict-filter hits are stored first
      // and preserved; broader rungs only add NEW segments. Dedup by
      // (documentId, position) — score varies per rung so it's not a
      // stable identity. Stop broadening once we have `limit` distinct hits.
      const seen = new Set();
      const lessonHits = [];
      const rungAttribution = [];
      for (let rungIdx = 0; rungIdx < ladder.length; rungIdx += 1) {
        const filters = ladder[rungIdx];
        const condition = buildMetadataCondition(filters);
        const records = await retrieveChunks(config, {
          datasetId: lessonDatasetId,
          query,
          metadataCondition: condition,
          scoreThreshold: threshold,
          topK: limit,
        });
        if (records.length === 0) continue;
        let added = 0;
        for (const r of records) {
          const compact = compactRecord(lessonDatasetId, r);
          const dedupKey = compact.segmentId
            || `${compact.documentId}:${compact.position ?? compact.documentName ?? ""}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          compact.kind = "lesson";
          compact.rungIndex = rungIdx;   // strict (lower) wins ordering
          lessonHits.push(compact);
          added += 1;
        }
        if (added > 0) rungAttribution.push({ filters, added });
        // Documented contract: broaden until at least 3 distinct hits OR
        // the ladder is exhausted. The min(3, limit) form prevents
        // over-broadening when the caller asks for a small result set
        // (e.g. limit=2 stops at 2) while still respecting the "3 hits"
        // floor for the typical limit=5 case.
        if (lessonHits.length >= Math.min(3, limit)) break;
      }
      // Stable sort: by rungIndex ASC (strict rung first), then by score
      // DESC within each rung. This actually preserves the strict-first
      // ordering the comment promises — the previous global score sort
      // would silently displace strict hits with high-scoring broad hits.
      lessonHits.sort((a, b) => {
        const r = (a.rungIndex ?? 0) - (b.rungIndex ?? 0);
        if (r !== 0) return r;
        return (b.score ?? -1) - (a.score ?? -1);
      });

      const supplementary = [];
      if (includeKnowledge !== false && project_module) {
        const knowledgeSlot = config.datasetMap.get("knowledge")?.id ? "knowledge" : null;
        if (knowledgeSlot) {
          const knowledgeId = resolveDatasetId(config, knowledgeSlot);
          for (const t of ["bug-root-cause", "feedback-rule"]) {
            const records = await retrieveChunks(config, {
              datasetId: knowledgeId,
              query,
              metadataCondition: buildMetadataCondition({ atom_type: t, project_module }),
              scoreThreshold: threshold,
            });
            for (const r of records.slice(0, 1)) {
              const compact = compactRecord(knowledgeId, r);
              compact.kind = "knowledge";
              supplementary.push(compact);
            }
          }
        }
      }

      // Lessons FIRST (the whole point of the tool); supplementary chunks
      // appended after, never displacing lessons. We cap lessons at `limit`
      // and append supplementary on top, so the caller always gets the full
      // {bug-root-cause, feedback-rule} cross-reference (max 2 records) when
      // includeKnowledge is on, even when lessons already filled `limit`.
      // The previous slice(0, limit) silently truncated supplementary to 0
      // whenever lessonHits.length >= limit.
      const all = [...lessonHits.slice(0, limit), ...supplementary];

      return jsonToolResponse({
        query,
        lessonDataset: lessonSlot,
        ladderUsed: rungAttribution,
        scoreThreshold: threshold,
        lessonHits: lessonHits.length,
        supplementaryHits: supplementary.length,
        totalRecords: all.length,
        records: all.map((r) => ({
          kind: r.kind,
          datasetId: r.datasetId,
          documentName: r.documentName,
          score: r.score,
          content: r.content,
        })),
      });
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
      "Walk the read-only /workspace mount inside the bridge container and return matching files with their suggested doc names (relative path with '/' replaced by '_'). Default include globs cover .md/.mdx/.markdown/.txt/.rst/.adoc; pass `include` to replace. The default ignore list (multi-stack vendor/build/cache/IDE protection: .git, node_modules, .venv, target, vendor, dist, build, .next, Pods, _build, .terraform, etc.) is ALWAYS applied; any `ignore` patterns you pass are added on top, never used as a replacement. This guarantees dependency trees never leak into an ingest pass.",
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
      const effectiveInclude = include && include.length > 0 ? include : defaultGlobs();
      const effectiveIgnore = mergeIgnore(ignore);
      const matches = findFiles(WORKSPACE_MOUNT, {
        include: effectiveInclude,
        ignore: ignore,  // findFiles re-merges; passing user's raw list keeps semantics in one place
      });
      return jsonToolResponse({
        root: WORKSPACE_MOUNT,
        include: effectiveInclude,
        ignore: effectiveIgnore,
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
