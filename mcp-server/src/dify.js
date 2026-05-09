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

export function buildDatasetMap(env = process.env) {
  const map = new Map();
  const declared = splitCsv(env.DIFY_DATASETS);

  for (const name of declared) {
    const slug = String(name).toLowerCase().trim();
    if (!slug) continue;
    const id = (env[envEnvKey(slug)] || "").trim();
    map.set(slug, { name: slug, id });
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
        `Dataset '${datasetNameOrId}' is not configured. Add to DIFY_DATASETS and set ${envEnvKey(datasetNameOrId)} in memory/.env, or run ./memory/scripts/dify-setup.sh.`,
      );
    }
    return resolved;
  }
  const fallback = config.legacyWriteDatasetId || config.datasetIds[0];
  if (!fallback) {
    throw new Error(
      "No write dataset configured. Run ./memory/scripts/dify-setup.sh, or set DIFY_DATASETS + DIFY_DATASET_<NAME>_ID in memory/.env.",
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

export async function createDataset(config, { name, description, indexingTechnique = "high_quality", permission = "only_me" }) {
  if (!name) throw new Error("createDataset requires a name.");
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets`;
  const payload = { name, indexing_technique: indexingTechnique, permission };
  if (description) payload.description = description;
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

export async function findDocumentByExactName(config, { datasetId, name }) {
  if (!name) throw new Error("findDocumentByExactName requires name.");
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const docs = await listAllDocuments(config, { datasetId: selectedDatasetId, keyword: name });
  return docs.find((d) => d?.name === name) || null;
}

export async function upsertDocumentByName(config, { datasetId, name, text }) {
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const existing = await findDocumentByExactName(config, { datasetId: selectedDatasetId, name });

  // Create-then-delete: if the create fails, the prior doc survives. Worst
  // case is a transient duplicate name in Dify until the next compile pass
  // resolves it; that is preferable to losing the only copy of a fact.
  const created = await createDocumentByText(config, { datasetId: selectedDatasetId, name, text });

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
