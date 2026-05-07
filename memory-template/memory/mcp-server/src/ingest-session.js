import { createDocumentByText, getConfig } from "./dify.js";

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--name") {
      parsed.name = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--dataset-id") {
      parsed.datasetId = argv[index + 1] || "";
      index += 1;
    }
  }

  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const args = parseArgs(process.argv.slice(2));
const text = (await readStdin()).trim();

if (!text) {
  throw new Error("No memory text received on stdin.");
}

const name = args.name || `session-memory-${new Date().toISOString()}.md`;
const config = getConfig();
const response = await createDocumentByText(config, {
  datasetId: args.datasetId,
  name,
  text,
});

console.log(JSON.stringify({ ok: true, name, response }, null, 2));
