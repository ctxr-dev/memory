export function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function intFromEnv(env, name, fallback) {
  const value = Number.parseInt(env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function maskSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function parseJsonObject(value, name) {
  if (!value || !value.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }

  throw new Error(`${name} must be a JSON object.`);
}

export function sessionProcessRuleFromEnv(env = process.env) {
  if (env.DIFY_SESSION_PROCESS_RULE_JSON && env.DIFY_SESSION_PROCESS_RULE_JSON.trim()) {
    return parseJsonObject(env.DIFY_SESSION_PROCESS_RULE_JSON, "DIFY_SESSION_PROCESS_RULE_JSON");
  }

  const preset = (env.DIFY_SESSION_PROCESS_RULE_PRESET || "conversation").trim();

  if (preset === "none" || preset === "inherit") {
    return undefined;
  }

  if (preset === "automatic") {
    return { mode: "automatic" };
  }

  if (preset !== "conversation") {
    throw new Error(
      "DIFY_SESSION_PROCESS_RULE_PRESET must be one of: conversation, automatic, none, inherit",
    );
  }

  return {
    mode: "custom",
    rules: {
      pre_processing_rules: [
        { id: "remove_extra_spaces", enabled: true },
        { id: "remove_urls_emails", enabled: false },
      ],
      segmentation: {
        separator: "\n\n### ",
        max_tokens: 700,
        chunk_overlap: 120,
      },
    },
  };
}

export async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (!response.ok) {
      const detail =
        body?.message ||
        body?.error ||
        body?.raw ||
        `${response.status} ${response.statusText}`;
      throw new Error(detail);
    }

    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function envEnvKey(name) {
  return `DIFY_DATASET_${String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ID`;
}

// Slot is declared by presence of any DIFY_DATASET_<NAME>_ID env line.
// Empty value means "I have not bound this slot yet" — listed but unbound.
export function buildDatasetMap(env = process.env) {
  const map = new Map();
  for (const key of Object.keys(env)) {
    const m = key.match(/^DIFY_DATASET_(.+)_ID$/);
    if (!m) continue;
    const slot = m[1].toLowerCase();
    if (map.has(slot)) continue;
    map.set(slot, { name: slot, id: String(env[key] || "").trim() });
  }

  // Back-compat: legacy single-write dataset becomes the unnamed default.
  const legacy = (env.DIFY_WRITE_DATASET_ID || "").trim();
  if (legacy && !Array.from(map.values()).some((d) => d.id === legacy)) {
    map.set("default", { name: "default", id: legacy });
  }

  return map;
}

export function getConfig(env = process.env) {
  const datasetMap = buildDatasetMap(env);
  const allDatasetIds = Array.from(datasetMap.values()).map((d) => d.id).filter(Boolean);
  const searchScope = splitCsv(env.DIFY_DATASET_IDS);

  return {
    apiUrl: env.DIFY_API_URL || "http://api:5001/v1",
    apiKey: env.DIFY_KNOWLEDGE_API_KEY || "",
    datasetMap,
    datasetIds: searchScope.length > 0 ? searchScope : allDatasetIds,
    flushDatasetName: (env.DIFY_FLUSH_DATASET || "daily").toLowerCase(),
    compileDatasetName: (env.DIFY_COMPILE_DATASET || "knowledge").toLowerCase(),
    absorbDefaultDatasetName: (env.DIFY_ABSORB_DEFAULT_DATASET || "knowledge").toLowerCase(),
    legacyWriteDatasetId: env.DIFY_WRITE_DATASET_ID || "",
    retrievalModel: parseJsonObject(env.DIFY_RETRIEVAL_MODEL_JSON, "DIFY_RETRIEVAL_MODEL_JSON"),
    sessionProcessRule: sessionProcessRuleFromEnv(env),
    sessionProcessRulePreset: env.DIFY_SESSION_PROCESS_RULE_PRESET || "conversation",
    sessionIndexingTechnique: env.DIFY_SESSION_INDEXING_TECHNIQUE || "high_quality",
    sessionDocForm: env.DIFY_SESSION_DOC_FORM || "text_model",
    sessionDocLanguage: env.DIFY_SESSION_DOC_LANGUAGE || "English",
    maxResults: intFromEnv(env, "MCP_MEMORY_MAX_RESULTS", 8),
    timeoutMs: intFromEnv(env, "MCP_MEMORY_TIMEOUT_MS", 20_000),
  };
}

export function resolveDatasetId(config, datasetNameOrId) {
  if (!datasetNameOrId) return "";
  const lower = String(datasetNameOrId).toLowerCase().trim();
  const entry = config.datasetMap?.get(lower);
  if (entry?.id) return entry.id;
  // If caller passed a raw UUID-shaped id, accept as-is.
  if (/^[0-9a-f-]{20,}$/i.test(String(datasetNameOrId).trim())) {
    return String(datasetNameOrId).trim();
  }
  return "";
}

export function requireDifyWriteConfig(config, datasetNameOrId) {
  if (!config.apiKey) {
    throw new Error("DIFY_KNOWLEDGE_API_KEY is not configured in memory/.env.");
  }
  if (datasetNameOrId) {
    const resolved = resolveDatasetId(config, datasetNameOrId);
    if (!resolved) {
      throw new Error(
        `Dataset '${datasetNameOrId}' is not configured. Add ${envEnvKey(datasetNameOrId)}=<dataset-id> to memory/.env (every DIFY_DATASET_<NAME>_ID line declares one slot), or run ./memory/scripts/dify-setup.sh.`,
      );
    }
    return resolved;
  }
  const fallback = config.legacyWriteDatasetId || config.datasetIds[0];
  if (!fallback) {
    throw new Error(
      "No write dataset configured. Run ./memory/scripts/dify-setup.sh, or add a DIFY_DATASET_<NAME>_ID=<dataset-id> line to memory/.env.",
    );
  }
  return fallback;
}

export async function listDatasets(config, { keyword, page = 1, limit = 100 } = {}) {
  const params = new URLSearchParams();
  if (keyword) params.set("keyword", keyword);
  params.set("page", String(page));
  params.set("limit", String(limit));
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets?${params.toString()}`;
  return fetchJsonWithTimeout(
    endpoint,
    { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } },
    config.timeoutMs,
  );
}

export async function listAllDatasets(config, { keyword } = {}) {
  const all = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const body = await listDatasets(config, { keyword, page, limit });
    const batch = Array.isArray(body?.data) ? body.data : [];
    all.push(...batch);
    if (!body?.has_more || batch.length === 0) break;
    page += 1;
    if (page > 100) break;
  }
  return all;
}

// Auto-created datasets default to high_quality indexing + hybrid retrieval
// (full-text + vector). Caveats:
//  * high_quality REQUIRES a tenant-default embedding model in Dify; if
//    none is configured the create call returns 400 with
//    "No Embedding Model available". The dify-setup.sh wizard documents
//    this prerequisite.
//  * embedding_model + embedding_model_provider can be passed explicitly
//    (read from DIFY_EMBEDDING_MODEL / DIFY_EMBEDDING_MODEL_PROVIDER) so
//    dataset creation succeeds before the tenant default is set.
//  * retrieval_model defaults to hybrid_search; reranking_enable is FALSE
//    by default to avoid invoking a missing reranker on Dify <= 1.0;
//    callers can flip it via DIFY_DEFAULT_RERANKING_ENABLE=true once a
//    reranker is configured.
export async function createDataset(config, {
  name,
  description,
  indexingTechnique = "high_quality",
  permission = "only_me",
  retrievalModel,
  embeddingModel,
  embeddingModelProvider,
}) {
  if (!name) throw new Error("createDataset requires a name.");
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets`;
  const defaultRetrievalModel = {
    search_method: "hybrid_search",
    reranking_enable: false,
    top_k: 8,
    score_threshold_enabled: false,
    score_threshold: 0,
  };
  const payload = {
    name,
    indexing_technique: indexingTechnique,
    permission,
    retrieval_model: retrievalModel || defaultRetrievalModel,
  };
  if (description) payload.description = description;
  // Pass-through embedding model when the tenant default isn't usable.
  const embedFromEnv = process.env.DIFY_EMBEDDING_MODEL || "";
  const embedProviderFromEnv = process.env.DIFY_EMBEDDING_MODEL_PROVIDER || "";
  const finalEmbed = embeddingModel || embedFromEnv;
  const finalEmbedProvider = embeddingModelProvider || embedProviderFromEnv;
  if (finalEmbed && finalEmbedProvider) {
    payload.embedding_model = finalEmbed;
    payload.embedding_model_provider = finalEmbedProvider;
  }
  return fetchJsonWithTimeout(
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
}

// ---------- Metadata fields ----------
//
// Dify only supports field types: string, number, time. There are no array
// fields; the boilerplate stores tags as a comma-separated string queried
// with the `contains` operator.
//
// Endpoints used:
//   GET    /datasets/{id}/metadata                           list fields
//   POST   /datasets/{id}/metadata                           create field
//   POST   /datasets/{id}/metadata/built-in/{enable|disable} toggle built-ins
//   POST   /datasets/{id}/documents/metadata                 set per-doc metadata

export async function listDatasetMetadataFields(config, { datasetId } = {}) {
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/metadata`;
  return fetchJsonWithTimeout(
    endpoint,
    { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } },
    config.timeoutMs,
  );
}

export async function createDatasetMetadataField(config, { datasetId, name, type = "string" }) {
  if (!name) throw new Error("createDatasetMetadataField requires a name.");
  if (!["string", "number", "time"].includes(type)) {
    throw new Error(`Unsupported metadata field type '${type}'. Use string|number|time.`);
  }
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/metadata`;
  return fetchJsonWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type, name }),
    },
    config.timeoutMs,
  );
}

export async function setBuiltInMetadata(config, { datasetId, enabled = true } = {}) {
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const action = enabled ? "enable" : "disable";
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/metadata/built-in/${action}`;
  return fetchJsonWithTimeout(
    endpoint,
    { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}` } },
    config.timeoutMs,
  );
}

// Resolve {fieldName -> fieldId} for a dataset (memoised by datasetId for the
// lifetime of one call). Uses listDatasetMetadataFields.
export async function loadMetadataFieldIndex(config, { datasetId } = {}) {
  const body = await listDatasetMetadataFields(config, { datasetId });
  const fields = Array.isArray(body?.doc_metadata) ? body.doc_metadata : [];
  const byName = new Map();
  for (const f of fields) {
    if (f?.name && f?.id) byName.set(f.name, { id: f.id, type: f.type });
  }
  return byName;
}

// metadataMap: plain { fieldName: value } object. Resolves field ids via
// loadMetadataFieldIndex and posts to the documents/metadata endpoint.
// Skips fields that are missing on the dataset (log to caller via return).
export async function updateDocumentMetadata(config, { datasetId, documentId, metadataMap } = {}) {
  if (!documentId) throw new Error("updateDocumentMetadata requires documentId.");
  const md = metadataMap && typeof metadataMap === "object" ? metadataMap : {};
  if (Object.keys(md).length === 0) return { ok: true, skipped: "empty metadata" };

  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const fieldIndex = await loadMetadataFieldIndex(config, { datasetId: selectedDatasetId });

  const metadataList = [];
  const skippedFields = [];
  for (const [name, value] of Object.entries(md)) {
    const f = fieldIndex.get(name);
    if (!f) { skippedFields.push(name); continue; }
    metadataList.push({ id: f.id, name, value: value == null ? "" : String(value) });
  }
  if (metadataList.length === 0) {
    return { ok: false, skippedFields, message: "no fields matched dataset metadata schema" };
  }

  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/documents/metadata`;
  const payload = {
    operation_data: [
      { document_id: documentId, metadata_list: metadataList },
    ],
  };
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
  return { ok: true, response: body, skippedFields };
}

export async function listDocuments(config, { datasetId, keyword, page = 1, limit = 100 } = {}) {
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const params = new URLSearchParams();
  if (keyword) params.set("keyword", keyword);
  params.set("page", String(page));
  params.set("limit", String(limit));
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/documents?${params.toString()}`;

  return fetchJsonWithTimeout(
    endpoint,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    },
    config.timeoutMs,
  );
}

export async function listAllDocuments(config, { datasetId, keyword } = {}) {
  const all = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const body = await listDocuments(config, { datasetId, keyword, page, limit });
    const batch = Array.isArray(body?.data) ? body.data : [];
    all.push(...batch);
    if (!body?.has_more || batch.length === 0) break;
    page += 1;
    if (page > 100) break;
  }
  return all;
}

export async function getDocumentSegments(config, { datasetId, documentId, page = 1, limit = 100 } = {}) {
  if (!documentId) throw new Error("getDocumentSegments requires documentId.");
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("limit", String(limit));
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/documents/${encodeURIComponent(documentId)}/segments?${params.toString()}`;

  return fetchJsonWithTimeout(
    endpoint,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    },
    config.timeoutMs,
  );
}

export async function getDocumentText(config, { datasetId, documentId } = {}) {
  const all = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const body = await getDocumentSegments(config, { datasetId, documentId, page, limit });
    const batch = Array.isArray(body?.data) ? body.data : [];
    all.push(...batch.sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0)).map((s) => s?.content || ""));
    if (!body?.has_more || batch.length === 0) break;
    page += 1;
    if (page > 100) break;
  }
  return all.join("\n\n");
}

// ---------- Retrieve with metadata filters + score threshold ----------
//
// metadataCondition is the Dify-shaped object:
//   { logical_operator: "and" | "or", conditions: [{ name, comparison_operator, value }] }
//
// Per Dify source (api/controllers/console/datasets/hit_testing_base.py +
// api/core/rag/retrieval/dataset_retrieval.py) and issue #29044, the wire
// JSON key is `metadata_filtering_conditions` and it lives INSIDE
// `retrieval_model`. Top-level `metadata_condition` is silently dropped.
//
// We send `retrieval_model` ONLY when the caller needs to attach a
// metadata filter / score threshold / explicit override. Otherwise we
// omit it so Dify falls back to the dataset's own configured retrieval
// settings (`dataset.retrieval_model or default_retrieval_model` per
// hit_testing_service.py). This keeps economy datasets working: if we
// always sent `hybrid_search`, economy datasets without a vector index
// would 5xx.

export async function retrieveChunks(config, { datasetId, query, metadataCondition, scoreThreshold, retrievalModel } = {}) {
  if (!datasetId) throw new Error("retrieveChunks requires datasetId.");
  if (!query) throw new Error("retrieveChunks requires query.");
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    datasetId,
  )}/retrieve`;

  const explicitRm = retrievalModel && typeof retrievalModel === "object"
    ? { ...retrievalModel }
    : config.retrievalModel
      ? { ...config.retrievalModel }
      : null;

  const wantsThreshold = typeof scoreThreshold === "number" && scoreThreshold >= 0 && scoreThreshold <= 1;
  const wantsMetadata = !!metadataCondition;

  let rm = explicitRm;
  if ((wantsThreshold || wantsMetadata) && !rm) {
    // Need to attach filter/threshold but caller supplied none. Build a
    // minimal rm: copy the dataset's own search method via a lightweight
    // GET would be ideal but adds an extra round-trip per call. Instead
    // we send only the filter/threshold fields and let Dify merge with
    // the dataset's configured defaults (per RetrievalModel Pydantic
    // partial-update semantics in dataset_retrieval.py).
    rm = {};
  }

  if (rm) {
    if (wantsThreshold) {
      rm.score_threshold = scoreThreshold;
      rm.score_threshold_enabled = true;
    }
    if (wantsMetadata) {
      rm.metadata_filtering_conditions = metadataCondition;
    }
  }

  const payload = { query };
  if (rm) payload.retrieval_model = rm;
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
  return Array.isArray(body?.records) ? body.records : [];
}

// Build a Dify metadata_condition from a flat {fieldName: value} map. All
// conditions are AND-combined. `tags` uses `contains`; everything else uses
// `is`. Empty values are skipped so callers can pass partial filters.
export function buildMetadataCondition(filters, { logicalOperator = "and", containsFields = ["tags"] } = {}) {
  if (!filters || typeof filters !== "object") return null;
  const conditions = [];
  for (const [name, raw] of Object.entries(filters)) {
    if (raw == null) continue;
    const value = String(raw).trim();
    if (!value) continue;
    const op = containsFields.includes(name) ? "contains" : "is";
    conditions.push({ name, comparison_operator: op, value });
  }
  if (conditions.length === 0) return null;
  return { logical_operator: logicalOperator, conditions };
}

export async function findDocumentByExactName(config, { datasetId, name }) {
  if (!name) throw new Error("findDocumentByExactName requires name.");
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const docs = await listAllDocuments(config, { datasetId: selectedDatasetId, keyword: name });
  return docs.find((d) => d?.name === name) || null;
}

export async function upsertDocumentByName(config, { datasetId, name, text, metadata }) {
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const existing = await findDocumentByExactName(config, { datasetId: selectedDatasetId, name });

  // Create-then-delete: if the create fails, the prior doc survives. Worst
  // case is a transient duplicate name in Dify until the next compile pass
  // resolves it; that is preferable to losing the only copy of a fact.
  const created = await createDocumentByText(config, { datasetId: selectedDatasetId, name, text });

  // Apply metadata after create (Dify's create-by-text endpoint does not
  // accept metadata in the same call). Failure to set metadata leaves the
  // document in place; we surface it via metadataError.
  let metadataError;
  let metadataResult;
  if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
    const newDocId = created?.document?.id || created?.id;
    if (newDocId) {
      try {
        metadataResult = await updateDocumentMetadata(config, {
          datasetId: selectedDatasetId,
          documentId: newDocId,
          metadataMap: metadata,
        });
      } catch (err) {
        metadataError = err instanceof Error ? err.message : String(err);
      }
    } else {
      metadataError = "create-by-text response missing document.id; cannot set metadata";
    }
  }

  let deleteError;
  if (existing?.id) {
    try {
      await deleteDocument(config, { datasetId: selectedDatasetId, documentId: existing.id });
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    name,
    datasetId: selectedDatasetId,
    replacedId: existing?.id || null,
    created,
    metadataResult,
    metadataError,
    deleteError,
  };
}

export async function deleteDocument(config, { datasetId, documentId }) {
  if (!documentId) {
    throw new Error("deleteDocument requires documentId.");
  }
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/documents/${encodeURIComponent(documentId)}`;

  return fetchJsonWithTimeout(
    endpoint,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
    config.timeoutMs,
  );
}

export async function disableDocument(config, { datasetId, documentId }) {
  if (!documentId) {
    throw new Error("disableDocument requires documentId.");
  }
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/documents/status/disable`;

  return fetchJsonWithTimeout(
    endpoint,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ document_ids: [documentId] }),
    },
    config.timeoutMs,
  );
}

export async function createDocumentByText(config, { datasetId, name, text }) {
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/document/create-by-text`;

  const payload = {
    name,
    text,
    indexing_technique: config.sessionIndexingTechnique,
    doc_form: config.sessionDocForm,
    doc_language: config.sessionDocLanguage,
  };

  if (config.sessionProcessRule) {
    payload.process_rule = config.sessionProcessRule;
  }

  return fetchJsonWithTimeout(
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
}
