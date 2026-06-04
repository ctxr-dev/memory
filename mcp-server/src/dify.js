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
// injection when a user pastes a key with stray newline into the canonical settings/.env.
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
    // Strip any stray CR/LF from header-bound values. ./.memory/src/scripts/dify-setup.sh writes
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
    throw new Error("DIFY_KNOWLEDGE_API_KEY is not configured in the canonical settings/.env.");
  }
  if (datasetNameOrId) {
    const resolved = resolveDatasetId(config, datasetNameOrId);
    if (!resolved) {
      throw new Error(
        `Dataset '${datasetNameOrId}' is not configured. Add ${slotEnvKey(datasetNameOrId)}=<dataset-id> to the canonical settings/.env (every DIFY_DATASET_<NAME>_ID line declares one slot), or run ./.memory/src/scripts/dify-setup.sh.`,
      );
    }
    return resolved;
  }
  const fallback = config.legacyWriteDatasetId || config.datasetIds[0];
  if (!fallback) {
    throw new Error(
      "No write dataset configured. Run ./.memory/src/scripts/dify-setup.sh, or add a DIFY_DATASET_<NAME>_ID=<dataset-id> line to the canonical settings/.env.",
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
//    "No Embedding Model available". The ./.memory/src/scripts/dify-setup.sh wizard documents
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
  const payload = {
    name,
    indexing_technique: indexingTechnique,
    permission,
  };
  if (description) payload.description = description;

  // Embedding model resolution. The Dify UI's System Default Embedding Model
  // is the single source of truth, and the bridge CANNOT read it through the
  // dataset Service API (that setting lives on the console API). So instead of
  // GUESSING a tenant default and forcing it (which on multi-provider tenants
  // picked the wrong model), we OMIT the embedding fields on create: Dify then
  // applies the tenant System Default automatically. Retrieval reads each
  // dataset's own stored model (see datasetMetaFor + retrieveChunks), so it
  // always matches whatever Dify chose here.
  //
  // Advanced callers may still pin a model explicitly (both args, or neither);
  // no shipped tool does. With an explicit pin we also carry the embedding into
  // a hybrid retrieval_model (Dify's pydantic validator requires it there).
  const finalEmbed = embeddingModel || "";
  const finalEmbedProvider = embeddingModelProvider || "";
  if (Boolean(finalEmbed) !== Boolean(finalEmbedProvider)) {
    throw new Error(
      "createDataset: explicit args must set BOTH embeddingModel and embeddingModelProvider, or neither.",
    );
  }
  if (finalEmbed && finalEmbedProvider) {
    payload.embedding_model = finalEmbed;
    payload.embedding_model_provider = finalEmbedProvider;
    const baseWeights = {
      vector_setting: { vector_weight: 0.7 },
      keyword_setting: { keyword_weight: 0.3 },
    };
    const caller = retrievalModel || {};
    const callerWeights = caller.weights || {};
    // Deep-merge weights so a PARTIAL caller override (e.g. just vector_weight)
    // can't strip the other required sub-keys (keyword_setting / vector_weight),
    // and apply the embedding_* fields LAST so they always survive — Dify's
    // hybrid_search validator requires them.
    const rm = {
      search_method: "hybrid_search",
      reranking_enable: false,
      reranking_mode: "weighted_score",
      top_k: 8,
      score_threshold_enabled: false,
      score_threshold: 0,
      ...caller,
      weights: {
        ...baseWeights,
        ...callerWeights,
        vector_setting: {
          ...baseWeights.vector_setting,
          ...(callerWeights.vector_setting || {}),
          embedding_provider_name: finalEmbedProvider,
          embedding_model_name: finalEmbed,
        },
        keyword_setting: {
          ...baseWeights.keyword_setting,
          ...(callerWeights.keyword_setting || {}),
        },
      },
    };
    payload.retrieval_model = rm;
  } else if (retrievalModel) {
    // Caller supplied a retrieval_model but no embedding pin: pass it through
    // as-is (their responsibility). Without an embedding pin we otherwise omit
    // retrieval_model so Dify can't reject a hybrid model that lacks the
    // required embedding fields.
    payload.retrieval_model = retrievalModel;
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

// Read ONE document's current custom-metadata as a { name: value } map. Dify has
// no single-document metadata endpoint, so this lists the dataset and finds the
// doc by id (O(dataset)). Only the read-merge path of updateDocumentMetadata uses
// it; the hot full-set callers bypass it via replace:true.
//
// Returns NULL when the document is not present in the listing (e.g. indexing lag
// on a freshly-created doc), distinct from {} which means "found, no custom
// fields". The caller MUST treat null as "could not confirm the existing set" and
// refuse a partial write (a {} fallback would let a partial POST wipe fields).
export async function getDocumentMetadataMap(config, { datasetId, documentId } = {}) {
  if (!documentId) throw new Error("getDocumentMetadataMap requires documentId.");
  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  // Page through and EARLY-EXIT as soon as the target doc is found, instead of
  // materialising the whole dataset (read-merge runs this per metadata write, so
  // the common case of finding the doc on an early page should be cheap).
  let page = 1;
  const limit = 100;
  while (true) {
    const body = await listDocuments(config, { datasetId: selectedDatasetId, page, limit });
    const batch = Array.isArray(body?.data) ? body.data : [];
    const doc = batch.find((d) => d?.id === documentId);
    if (doc) {
      const out = {};
      const fields = Array.isArray(doc.doc_metadata) ? doc.doc_metadata : [];
      for (const f of fields) if (f?.name) out[f.name] = f.value;
      return out;
    }
    if (!body?.has_more || batch.length === 0) break;
    page += 1;
    if (page > 100) {
      // Same ~10k hard cap as listAllDocuments. Warn (don't truncate silently):
      // returning null here makes updateDocumentMetadata refuse a read-merge, and
      // the operator should know it is pagination truncation, not indexing lag.
      process.stderr.write(
        `[dify] getDocumentMetadataMap hit the 100-page cap for dataset ${selectedDatasetId} without finding ${documentId} (has_more still true); treating as not-found (a read-merge will refuse).\n`,
      );
      break;
    }
  }
  return null; // not found in the listing (distinct from {} = found, no custom fields)
}

// metadataMap: plain { fieldName: value } object. Resolves field ids via
// loadMetadataFieldIndex and posts to the documents/metadata endpoint.
// Skips fields that are missing on the dataset (log to caller via return).
//
// CONTRACT: Dify's POST /documents/metadata REPLACES the document's ENTIRE
// custom-metadata set with metadata_list, so a partial map silently wipes every
// field not included. To make that safe by default, this helper READ-MERGES: it
// fetches the doc's current custom metadata and overlays the provided fields
// (provided values win). Callers that already hold the COMPLETE intended set
// (a freshly-created doc with no prior metadata; the consolidate engine, which
// builds the full merged map in memory from its working set) pass `replace: true`
// to skip the extra dataset read. A read failure throws (the update aborts)
// rather than writing a partial set that would corrupt classifying metadata.
export async function updateDocumentMetadata(config, { datasetId, documentId, metadataMap, replace = false } = {}) {
  if (!documentId) throw new Error("updateDocumentMetadata requires documentId.");
  const md = metadataMap && typeof metadataMap === "object" ? metadataMap : {};
  if (Object.keys(md).length === 0) return { ok: true, skipped: "empty metadata" };

  const selectedDatasetId = requireDifyWriteConfig(config, datasetId);
  const fieldIndex = await loadMetadataFieldIndex(config, { datasetId: selectedDatasetId });

  let effectiveMap = md;
  if (!replace) {
    const current = await getDocumentMetadataMap(config, { datasetId: selectedDatasetId, documentId });
    if (current == null) {
      // Document not found in the dataset listing (e.g. indexing lag). We cannot
      // confirm its existing custom set, and a partial POST would REPLACE the
      // full set and wipe unrelated fields, so REFUSE rather than write a
      // patch-only metadata_list. A caller that knows it holds the complete set
      // (a brand-new doc) should pass replace:true to skip this read entirely.
      throw new Error(
        `updateDocumentMetadata: document ${documentId} not found in dataset ${selectedDatasetId} listing; ` +
          "refusing a partial metadata write that could wipe existing fields. Pass replace:true if you hold the complete set.",
      );
    }
    effectiveMap = { ...current, ...md };
  }

  const metadataList = [];
  const skippedFields = [];
  for (const [name, value] of Object.entries(effectiveMap)) {
    const f = fieldIndex.get(name);
    if (!f) { skippedFields.push(name); continue; }
    metadataList.push({ id: f.id, name, value: value == null ? "" : String(value) });
  }
  if (metadataList.length === 0) {
    // Treat as a CONFIG WARNING, not a failure: the document was written,
    // there are simply no matching metadata fields on the dataset (user
    // skipped ./.memory/src/scripts/dify-setup.sh schema install). Caller can read the warning
    // but should NOT count this against the daily-doc retry cap.
    return {
      ok: true,
      warning: "no fields matched dataset metadata schema; run ./.memory/src/scripts/dify-setup.sh to install per-document fields",
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
    if (page > 100) {
      // Hard cap at ~10k docs (100 pages x 100). Do NOT truncate silently: callers
      // that build a doc map from this (getDocumentMetadataMap, recall-stamp,
      // list-consolidate) would otherwise treat a doc beyond the cap as "not found"
      // (read-merge then refuses; consolidate skips it). Surface it so an operator
      // with a dataset this large knows to raise the cap / paginate differently.
      process.stderr.write(
        `[dify] listAllDocuments hit the 100-page cap (~${all.length} docs) for dataset ${datasetId} with has_more still true; results are TRUNCATED.\n`,
      );
      break;
    }
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

// datasetId -> { indexingTechnique, embeddingModel, embeddingProvider }
// One GET /datasets/{id} feeds both the indexing-technique decision and the
// per-dataset embedding model that hybrid_search retrieval requires.
const datasetMetaCache = new Map();

export async function getDatasetInfo(config, { datasetId } = {}) {
  if (!datasetId) throw new Error("getDatasetInfo requires datasetId.");
  const endpoint = `${config.apiUrl.replace(/\/+$/, "")}/datasets/${encodeURIComponent(datasetId)}`;
  return fetchJsonWithTimeout(
    endpoint,
    { method: "GET", headers: { Authorization: `Bearer ${config.apiKey}` } },
    config.timeoutMs,
  );
}

// Resolve (and cache) a dataset's indexing technique + its OWN embedding model
// and provider. Retrieval must echo the dataset's embedding model back to Dify
// (the hybrid_search pydantic validator requires it), and reading it from the
// dataset itself is always correct — no tenant-wide guessing, robust to a
// tenant with multiple embedding providers.
export async function datasetMetaFor(config, datasetId) {
  if (datasetMetaCache.has(datasetId)) return datasetMetaCache.get(datasetId);
  // Let a GET failure (404 / auth / network) PROPAGATE with its real message
  // rather than masking it as a misleading "embedding could not be resolved"
  // downstream. We don't cache failures, so the next call retries.
  const info = await getDatasetInfo(config, { datasetId });
  const meta = {
    indexingTechnique: info?.indexing_technique || "high_quality",
    embeddingModel: info?.embedding_model || "",
    embeddingProvider: info?.embedding_model_provider || "",
  };
  datasetMetaCache.set(datasetId, meta);
  return meta;
}

async function indexingTechniqueFor(config, datasetId) {
  // Resilient: callers that only need the technique (not the embedding) should
  // not break if the probe fails — assume the boilerplate default.
  try {
    return (await datasetMetaFor(config, datasetId)).indexingTechnique;
  } catch {
    return "high_quality";
  }
}

// Cache the resolved tenant default embedding model so we don't re-query
// on every retrieve / dataset create. The bridge container is long-lived;
// the system default rarely changes mid-session, and if it does the user
// can recreate the bridge to bust the cache.
let _embeddingDefaultCache = null;     // null = not yet resolved
let _embeddingDefaultPromise = null;   // in-flight promise dedup

// INFORMATIONAL FALLBACK ONLY. This is NOT used to create datasets or build
// retrieval requests any more — those omit the embedding (Dify applies the
// tenant System Default on create) and read each dataset's OWN model on
// retrieve (see createDataset / datasetMetaFor / defaultRetrievalModelFor).
// The reason: the dataset Service API CANNOT read the tenant System Default
// (that lives on the console API), so this can only GUESS the alphabetical-
// first active provider, which is wrong on multi-provider tenants. It now
// survives solely as a last-resort label for `get-embedding-default` when no
// dataset is bound yet; callers tag its result `tenant_guess`.
//
// Returns:
//   { provider, model, source: "tenant" }       — alphabetical-first guess
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

// Build the retrieval_model for a dataset. For high_quality datasets, Dify's
// hybrid_search validator REQUIRES embedding_provider_name + embedding_model_name
// in weights.vector_setting; we pass the DATASET'S OWN embedding model (resolved
// by the caller via datasetMetaFor), which always matches what the dataset was
// created with. Economy datasets have no vector index -> keyword_search.
function defaultRetrievalModelFor(indexingTechnique, { embeddingModel, embeddingProvider } = {}) {
  if (indexingTechnique === "economy") {
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
  const vectorSetting = { vector_weight: 0.7 };
  if (embeddingProvider && embeddingModel) {
    vectorSetting.embedding_provider_name = embeddingProvider;
    vectorSetting.embedding_model_name = embeddingModel;
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
    // Probe the dataset once (cached): its indexing technique decides
    // hybrid_search (high_quality) vs keyword_search (economy), and its own
    // embedding model is echoed back into the hybrid_search vector_setting.
    const meta = await datasetMetaFor(config, datasetId);
    if (meta.indexingTechnique !== "economy" && !(meta.embeddingProvider && meta.embeddingModel)) {
      throw new Error(
        `retrieveChunks: dataset ${datasetId} is high_quality but its embedding model could not be resolved from Dify; cannot build a valid hybrid_search request.`,
      );
    }
    rm = defaultRetrievalModelFor(meta.indexingTechnique, {
      embeddingModel: meta.embeddingModel,
      embeddingProvider: meta.embeddingProvider,
    });
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
// Stable string identity for a filters object. Used as a dedup key so two
// equivalent filter sets (same keys, same values, different insertion
// order) hash to the same string. JSON.stringify alone preserves insertion
// order in V8 today but a future refactor adding conditional keys could
// silently break dedup. Sort keys before stringifying so the contract
// survives reorderings.
export function canonicalFilterKey(filters) {
  // Always return a STRING (the documented "stable string identity"
  // contract — it is used as a Set dedup key). For non-object inputs,
  // JSON.stringify can yield the VALUE undefined (e.g.
  // JSON.stringify(undefined) === undefined, not a string) or otherwise
  // non-string results; coerce via String() so a dedup key is never
  // `undefined`. In practice the ladder always passes plain objects, but
  // the contract holds for any input.
  if (!filters || typeof filters !== "object") return String(JSON.stringify(filters));
  const sorted = {};
  for (const key of Object.keys(filters).sort()) sorted[key] = filters[key];
  return JSON.stringify(sorted);
}

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
          // Freshly-created doc: `metadata` is the complete intended set and the
          // doc has no prior custom fields, so skip the read-merge.
          replace: true,
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
