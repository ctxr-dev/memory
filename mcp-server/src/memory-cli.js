import {
  createDocumentByText,
  deleteDocument,
  disableDocument,
  fetchJsonWithTimeout,
  getConfig,
  requireDifyWriteConfig,
} from "./dify.js";

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

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function searchCmd(config, { query, datasetId, limit }) {
  if (!query || typeof query !== "string") {
    throw new Error("--query <string> is required");
  }
  const datasets = datasetId ? [datasetId] : config.datasetIds;
  if (datasets.length === 0) {
    throw new Error("No dataset configured. Set DIFY_DATASET_IDS or pass --datasetId.");
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
    datasetId: datasetId || requireDifyWriteConfig(config),
    name,
    created,
    supersedes: supersedes
      ? { documentId: supersedes, action: supersedesAction || "disable", result: supersede }
      : undefined,
  };
}

async function disableCmd(config, { datasetId, documentId }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  return disableDocument(config, { datasetId, documentId });
}

async function deleteCmd(config, { datasetId, documentId }) {
  if (!documentId) throw new Error("--documentId <id> is required");
  return deleteDocument(config, { datasetId, documentId });
}

const args = parseArgs(process.argv.slice(2));
const sub = args._[0];

try {
  const config = getConfig();
  let result;
  switch (sub) {
    case "search":
      result = await searchCmd(config, args);
      break;
    case "write":
      result = await writeCmd(config, args);
      break;
    case "disable":
      result = await disableCmd(config, args);
      break;
    case "delete":
      result = await deleteCmd(config, args);
      break;
    default:
      console.error(`Unknown subcommand: ${sub || "(none)"}`);
      console.error("Usage: memory-cli.js <search|write|disable|delete> [--flag value]");
      process.exit(2);
  }
  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
