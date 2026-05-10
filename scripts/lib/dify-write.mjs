import { spawn } from "node:child_process";
import { envValue } from "./env.mjs";

export class DifyBridgeUnavailable extends Error {}

const DEFAULT_TIMEOUT_MS = 60_000;

function containerName() {
  const name = envValue("MCP_CONTAINER_NAME");
  if (!name) {
    throw new DifyBridgeUnavailable("MCP_CONTAINER_NAME not set in memory/.env");
  }
  return name;
}

async function execCli(subcommand, flags = {}, { stdin, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const container = containerName();
  const args = ["exec", "-i", container, "node", "src/memory-cli.js", subcommand];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === "") continue;
    args.push(`--${key}`);
    if (value !== true) args.push(String(value));
  }

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new DifyBridgeUnavailable(`docker exec ${subcommand} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (c) => stdout.push(c));
    child.stderr.on("data", (c) => stderr.push(c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new DifyBridgeUnavailable(`docker exec failed to start: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const errOut = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new DifyBridgeUnavailable(`memory-cli ${subcommand} exited ${code}: ${errOut.trim() || out.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new DifyBridgeUnavailable(`memory-cli ${subcommand} returned non-JSON: ${out.slice(0, 300)}`));
      }
    });

    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export function writeMemory({ name, text, datasetId, supersedes, supersedesAction } = {}) {
  return execCli(
    "write",
    { name, datasetId, supersedes, supersedesAction },
    { stdin: text },
  );
}

// Exported for unit tests. Builds the --flag map that saveDocument hands
// to execCli. The empty-metadata short-circuit (typeof check + key count)
// is the single source of truth for "should we send a --metadata flag?".
// Refactor with care: the bridge `save` subcommand parses --metadata as
// JSON and skips application when absent, so an erroneous "{}" or
// "undefined" string would silently downgrade the call.
export function buildSaveFlags({ name, datasetId, metadata }) {
  const flags = { name, datasetId };
  if (metadata && typeof metadata === "object" && Object.keys(metadata).length > 0) {
    flags.metadata = JSON.stringify(metadata);
  }
  return flags;
}

export function saveDocument({ name, text, datasetId, metadata } = {}) {
  return execCli("save", buildSaveFlags({ name, datasetId, metadata }), { stdin: text });
}

export function disableDocument({ documentId, datasetId } = {}) {
  return execCli("disable", { documentId, datasetId });
}

export function deleteDocument({ documentId, datasetId } = {}) {
  return execCli("delete", { documentId, datasetId });
}

export function listDocuments({ prefix, enabled, datasetId } = {}) {
  return execCli("list", { prefix, enabled, datasetId });
}

export function readDocument({ documentId, datasetId } = {}) {
  return execCli("read", { documentId, datasetId });
}

export function searchMemoryFiltered({ query, datasetId, limit, filters, scoreThreshold } = {}) {
  const flags = { query, datasetId, limit };
  if (filters && typeof filters === "object") flags.filters = JSON.stringify(filters);
  if (scoreThreshold != null) flags.scoreThreshold = String(scoreThreshold);
  return execCli("search", flags);
}

export function setBuiltInMetadata({ datasetId, enabled } = {}) {
  return execCli("set-built-in-metadata", { datasetId, enabled: String(enabled !== false) });
}

export function updateDocMetadata({ datasetId, documentId, metadata } = {}) {
  const flags = { datasetId, documentId };
  if (metadata && typeof metadata === "object") flags.metadata = JSON.stringify(metadata);
  return execCli("update-doc-metadata", flags);
}

export function listDatasets() {
  return execCli("list-datasets", {});
}
