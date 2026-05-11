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

// Strip CR/LF (and trailing whitespace) from a value that will be
// interpolated into an HTTP header or URL. Defensive: prevents CRLF
// injection when a user pastes a key with stray newline into memory/.env.
export function sanitizeHeaderValue(value) {
  if (value == null) return "";
  return String(value).replace(/[\r\n]+/g, "").trim();
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

// Bridge-side mirror of scripts/lib/env.mjs:slotEnvKey() — the host
// helper cannot be imported here because the bridge runs in a separate
// Node module without access to ../scripts/lib/. Cross-runtime parity
// is locked by test/cross-runtime-slug-sync.test.mjs which imports BOTH
// `hostSlotEnvKey` (host) and THIS function and runs the same set of
// slot inputs through both. Treats null/undefined/falsy inputs the same
// as the host helper (empty string, not the literal "null" / "undefined")
// so a defensive caller passing `undefined` doesn't produce a different
// env-var name across runtimes.
//
// Param name matches the host signature (`slot`) for symmetry in IDE
// hover help. **@internal** — exported only so the parity test in
// test/cross-runtime-slug-sync.test.mjs can import it directly; no
// production code outside this module should import it.
export function slotEnvKey(slot) {
  return `DIFY_DATASET_${String(slot || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ID`;
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
    // Strip any stray CR/LF from header-bound values. dify-setup.sh writes
    // user-pasted keys verbatim and a key copied from a wrapped Dify UI line
    // can carry trailing whitespace; without sanitisation the Bearer header
    // would be CRLF-injected. Operator-controlled, so non-exploitable in the
    // current trust model — but defensive sanitisation costs nothing.
    apiUrl: sanitizeHeaderValue(env.DIFY_API_URL || "http://api:5001/v1"),
    apiKey: sanitizeHeaderValue(env.DIFY_KNOWLEDGE_API_KEY || ""),
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
        `Dataset '${datasetNameOrId}' is not configured. Add ${slotEnvKey(datasetNameOrId)}=<dataset-id> to memory/.env (every DIFY_DATASET_<NAME>_ID line declares one slot), or run ./memory/scripts/dify-setup.sh.`,
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
//    by an in-process caller (advanced API surface). When neither
//    explicit args nor a tenant default exists, the create call returns
//    a 400 with the "No Embedding Model available" message above.
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
  // Well-formed RetrievalModel: search_method REQUIRED. reranking_mode +
  // weights provided so later /retrieve calls that fall back to this
  // dataset default don't trip "KeyError: reranking_mode" on Dify versions
  // that strictly validate the persisted model.
  const defaultRetrievalModel = {
    search_method: "hybrid_search",
    reranking_enable: false,
    reranking_mode: "weighted_score",
    weights: {
      vector_setting: { vector_weight: 0.7 },
      keyword_setting: { keyword_weight: 0.3 },
    },
    top_k: 8,
    score_threshold_enabled: false,
    score_threshold: 0,
  };
  // Spread-merge so a caller-supplied retrievalModel doesn't drop the
  // reranking_mode/weights defaults (which Dify requires for the persisted
  // dataset model in newer versions).
  const payload = {
    name,
    indexing_technique: indexingTechnique,
    permission,
    retrieval_model: { ...defaultRetrievalModel, ...(retrievalModel || {}) },
  };
  if (description) payload.description = description;
  // Resolve embedding (model + provider) using a 2-step precedence:
  //   1. Explicit args from the caller (advanced API surface; no
  //      shipped tool currently passes these).
  //   2. Auto-discovered from the Dify tenant (the System Default
  //      Embedding Model configured in the UI).
  // The Dify UI is the SINGLE source of truth. We deliberately do not
  // honour DIFY_EMBEDDING_MODEL{,_PROVIDER} env vars — exposing them
  // would create two sources of truth that drift.
  let finalEmbed = embeddingModel || "";
  let finalEmbedProvider = embeddingModelProvider || "";
  if (Boolean(finalEmbed) !== Boolean(finalEmbedProvider)) {
    throw new Error(
      "createDataset: explicit args must set BOTH embeddingModel and embeddingModelProvider, or neither.",
    );
  }
  if (!finalEmbed && !finalEmbedProvider) {
    const resolved = await getDefaultEmbeddingModel(config);
    if (resolved && resolved.provider && resolved.model) {
      finalEmbed = resolved.model;
      finalEmbedProvider = resolved.provider;
    }
  }
  if (finalEmbed && finalEmbedProvider) {
    payload.embedding_model = finalEmbed;
    payload.embedding_model_provider = finalEmbedProvider;
    // Dify 1.14+ also requires embedding_provider_name +
    // embedding_model_name INSIDE retrieval_model.weights.vector_setting
    // for hybrid_search. The top-level fields above set the dataset
    // default; the nested fields satisfy the pydantic validator on
    // every retrieve. Both are needed.
    const rm = payload.retrieval_model;
    if (rm && rm.weights && rm.weights.vector_setting) {
      rm.weights.vector_setting.embedding_provider_name = finalEmbedProvider;
      rm.weights.vector_setting.embedding_model_name = finalEmbed;
    }
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
    // Treat as a CONFIG WARNING, not a failure: the document was written,
    // there are simply no matching metadata fields on the dataset (user
    // skipped dify-setup.sh schema install). Caller can read the warning
    // but should NOT count this against the daily-doc retry cap.
    return {
      ok: true,
      warning: "no fields matched dataset metadata schema; run ./memory/scripts/dify-setup.sh to install per-document fields",
      skippedFields,
    };
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
// When the caller needs to attach a filter / threshold / explicit override
// we MUST send a complete retrieval_model (Dify's RetrievalModel Pydantic
// schema requires `search_method`). To stay correct on BOTH high_quality
// and economy datasets, we probe the dataset's `indexing_technique` once
// (cached per process) and pick semantic_search-ish behaviour when the
// dataset has no vector index.

const datasetIndexCache = new Map(); // datasetId -> "high_quality" | "economy"

export async function getDatasetInfo(config, { datasetId } = {}) {
  if (!datasetId) throw new Error("getDatasetInfo requires datasetId.");
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(datasetId)}`;
  return fetchJsonWithTimeout(
    endpoint,
    { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } },
    config.timeoutMs,
  );
}

async function indexingTechniqueFor(config, datasetId) {
  if (datasetIndexCache.has(datasetId)) return datasetIndexCache.get(datasetId);
  try {
    const info = await getDatasetInfo(config, { datasetId });
    const tech = info?.indexing_technique || "high_quality";
    datasetIndexCache.set(datasetId, tech);
    return tech;
  } catch {
    // If probe fails, assume high_quality (the boilerplate's default).
    return "high_quality";
  }
}

// Cache the resolved tenant default embedding model so we don't re-query
// on every retrieve / dataset create. The bridge container is long-lived;
// the system default rarely changes mid-session, and if it does the user
// can recreate the bridge to bust the cache.
let _embeddingDefaultCache = null;     // null = not yet resolved
let _embeddingDefaultPromise = null;   // in-flight promise dedup

// Resolve the embedding model name + provider URI to use for any
// hybrid_search call by querying the Dify tenant directly:
//   `/v1/workspaces/current/models/model-types/text-embedding`.
// Picks the alphabetical-first active provider's first model.
//
// The Dify UI's System Model Settings is the SINGLE source of truth.
// We deliberately do NOT honour DIFY_EMBEDDING_MODEL{,_PROVIDER} env
// vars: exposing them as "advanced overrides" creates two sources of
// truth that drift, and the very existence of the override config in
// `.env.example` invites users to ask "do I need to set this?" — the
// same redundant-config friction that this auto-discovery was meant
// to eliminate. If a user has multiple embedding providers configured
// and wants to pin a specific one for memory, they configure it as
// the System Default in the Dify UI; everything that consumes
// embeddings (memory + any other Dify app in the tenant) uses the
// same value.
//
// Returns:
//   { provider, model, source: "tenant" }       — tenant default in use
//   { provider: "", model: "", source: "tenant_empty" } — no model in tenant
//   { provider: "", model: "", source: "probe_failed", error } — transient
export async function getDefaultEmbeddingModel(config) {
  if (_embeddingDefaultCache !== null) return _embeddingDefaultCache;
  if (_embeddingDefaultPromise) return _embeddingDefaultPromise;
  _embeddingDefaultPromise = (async () => {
    try {
      const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/workspaces/current/models/model-types/text-embedding`;
      const body = await fetchJsonWithTimeout(
        endpoint,
        { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } },
        config.timeoutMs,
      );
      const providers = Array.isArray(body?.data) ? body.data : [];
      const active = providers
        .filter((p) => p && p.status === "active" && Array.isArray(p.models) && p.models.length > 0)
        // Sort alphabetically by provider URI so the chosen default is
        // DETERMINISTIC across bridge restarts and across tenants where
        // providers were installed in different orders. Without this,
        // `active[0]` depends on Dify's internal ordering (install
        // sequence), which can flip silently on a tenant rebuild.
        .sort((a, b) => String(a.provider || "").localeCompare(String(b.provider || "")));
      if (active.length === 0) {
        // tenant_empty IS a stable config state (the user hasn't
        // configured any embedding model in the UI). Cache it so we
        // don't re-probe on every retrieve. The user fixes this in the
        // Dify UI and recreates the bridge to bust the cache.
        _embeddingDefaultCache = { provider: "", model: "", source: "tenant_empty" };
        return _embeddingDefaultCache;
      }
      const chosen = active[0];
      const chosenModel = chosen.models[0];
      if (active.length > 1) {
        process.stderr.write(
          `dify.js: multiple embedding providers configured in the Dify tenant (${active.map((p) => p.provider).join(", ")}); using '${chosen.provider}' / '${chosenModel?.model}' (alphabetical-first). To pin a specific one, set it as the System Default Embedding Model in the Dify UI (Settings → Model Provider → System Model Settings).\n`,
        );
      }
      _embeddingDefaultCache = {
        provider: chosen.provider || "",
        model: chosenModel?.model || "",
        source: "tenant",
      };
      return _embeddingDefaultCache;
    } catch (err) {
      // Probe failed (network blip, transient Dify restart, etc). Do
      // NOT cache the failure — leave _embeddingDefaultCache as null so
      // the next call retries the probe. Caching a transient failure
      // would mean a single network blip starves embedding-discovery
      // for the rest of the bridge's lifetime. The current call still
      // proceeds without vector_setting fields and lets Dify produce a
      // friendlier error if it can't fall back internally.
      process.stderr.write(`dify.js: embedding probe failed (transient, will retry on next call): ${err?.message}\n`);
      return { provider: "", model: "", source: "probe_failed", error: err?.message };
    } finally {
      _embeddingDefaultPromise = null;
    }
  })();
  return _embeddingDefaultPromise;
}

// Build the retrieval_model. Now async because it auto-discovers the
// embedding model from the tenant when env vars aren't set. Caching
// inside getDefaultEmbeddingModel makes repeated calls free.
async function defaultRetrievalModelFor(indexingTechnique, config) {
  if (indexingTechnique === "economy") {
    // Economy datasets have no vector index — keyword-only retrieval is
    // the only option Dify accepts.
    return {
      search_method: "keyword_search",
      reranking_enable: false,
      top_k: 8,
      // Dify 1.14+ requires score_threshold_enabled in HitTestingPayload
      // even for economy / keyword_search.
      score_threshold_enabled: false,
      score_threshold: 0,
    };
  }
  // Dify 1.14+ requires embedding_provider_name + embedding_model_name
  // INSIDE weights.vector_setting when search_method is hybrid_search.
  // Resolve via getDefaultEmbeddingModel — the Dify UI's System Default
  // Embedding Model is the single source of truth. No env-var overrides
  // (see getDefaultEmbeddingModel header for the full rationale).
  const vectorSetting = { vector_weight: 0.7 };
  if (config) {
    const resolved = await getDefaultEmbeddingModel(config);
    if (resolved && resolved.provider && resolved.model) {
      vectorSetting.embedding_provider_name = resolved.provider;
      vectorSetting.embedding_model_name = resolved.model;
    }
  }
  return {
    search_method: "hybrid_search",
    reranking_enable: false,
    reranking_mode: "weighted_score",
    weights: {
      vector_setting: vectorSetting,
      keyword_setting: { keyword_weight: 0.3 },
    },
    top_k: 8,
    // Dify 1.14+ requires score_threshold_enabled even when threshold is 0.
    score_threshold_enabled: false,
    score_threshold: 0,
  };
}

export async function retrieveChunks(config, { datasetId, query, metadataCondition, scoreThreshold, topK, retrievalModel } = {}) {
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
  const wantsTopK = Number.isFinite(topK) && topK > 0;

  let rm = explicitRm;
  if ((wantsThreshold || wantsMetadata || wantsTopK) && !rm) {
    // Probe the dataset to decide between hybrid_search (high_quality) and
    // keyword_search (economy). Cached per-process.
    const tech = await indexingTechniqueFor(config, datasetId);
    rm = await defaultRetrievalModelFor(tech, config);
  }

  if (rm) {
    if (wantsThreshold) {
      rm.score_threshold = scoreThreshold;
      rm.score_threshold_enabled = true;
    }
    if (wantsMetadata) {
      rm.metadata_filtering_conditions = metadataCondition;
    }
    if (wantsTopK) {
      // Caller asks for N results; otherwise the dataset's default top_k
      // (often 8) caps results regardless of how many we slice on the
      // client. Without this, --limit 50 silently returns 8.
      rm.top_k = Math.floor(topK);
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

// Pick same-name documents to delete after creating a replacement.
// Exported for unit testing. The filter enforces (a) exact-name match
// (Dify's `keyword` filter is server-side substring; without this guard
// we'd delete unrelated docs sharing a prefix), (b) the just-created
// doc is never deleted (it's the one we want to keep), and (c) malformed
// entries without an `id` are skipped.
//
// Critical null-guard: if `newDocId` is null/undefined (the create
// response failed to surface an id), `d.id !== newDocId` would be true
// for EVERY doc and we'd delete the freshly-created one along with the
// duplicates. Bail out — we'd rather leave duplicates than nuke the new
// write. Caller surfaces this via `metadataError` / next-upsert merging.
export function pickDuplicatesToDelete(docs, name, newDocId) {
  if (!Array.isArray(docs)) return [];
  if (newDocId == null) return [];
  return docs.filter((d) => d?.id && d.id !== newDocId && d?.name === name);
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

  // Re-list at delete time to catch ANY doc with the same name that is
  // not the one we just created. Closes the concurrent-write race
  // window: if two upserts run in parallel, both see the SAME `existing`
  // at find time but each creates a new doc; the naive single-id delete
  // would leave one orphan. By re-listing here we delete every same-name
  // doc except the freshly-created one, regardless of how many concurrent
  // calls happened. Worst case (all concurrent calls succeed in create
  // and then race here) the dataset settles to ONE doc with the latest
  // body — no orphans, no infinite multiplication.
  const newDocId = created?.document?.id || created?.id || null;
  let deleteError;
  let deletedCount = 0;
  if (newDocId) {
    try {
      // Note: Dify's `keyword` filter is a SUBSTRING match (server-side),
      // so a query for "plan-foo" can return both "plan-foo.md" and
      // "plan-foo-bar.md". The `.name === name` filter on the line below
      // enforces exact match before we issue any delete. Without that
      // exact-match guard, this loop would happily delete unrelated docs
      // whose names share a prefix with the new doc's name.
      const sameName = await listAllDocuments(config, { datasetId: selectedDatasetId, keyword: name });
      const toDelete = pickDuplicatesToDelete(sameName, name, newDocId);
      for (const dup of toDelete) {
        try {
          await deleteDocument(config, { datasetId: selectedDatasetId, documentId: dup.id });
          deletedCount += 1;
        } catch (err) {
          // Aggregate per-id failures into one error string but keep going;
          // a 404 here means a sibling concurrent upsert already deleted it.
          const m = err instanceof Error ? err.message : String(err);
          deleteError = deleteError ? `${deleteError}; ${m}` : m;
        }
      }
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    name,
    datasetId: selectedDatasetId,
    replacedId: existing?.id || null,
    deletedCount,
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

// Symmetric counterpart to disableDocument: re-enable a previously
// disabled document so it shows up in search again. Same endpoint shape
// as disable except the action verb. Exposed as the `enable_document`
// MCP tool so the disable/enable pair stays inside the MCP surface and
// agents don't need to drop into the Dify UI to undo a soft delete.
export async function enableDocument(config, { datasetId, documentId }) {
  if (!documentId) {
    throw new Error("enableDocument requires documentId.");
  }
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(
    selectedDatasetId,
  )}/documents/status/enable`;

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
