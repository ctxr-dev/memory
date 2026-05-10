import { spawn } from "node:child_process";
import { envValue } from "./env.mjs";

export class DifyBridgeUnavailable extends Error {}

// 180s default: a Dify create-by-text on a multi-KB plan body
// synchronously triggers embedding for the full doc, which can queue
// behind other embeds when OpenAI rate-limits. 60s was too tight for
// the new save path; we choose 180s as a balance (still bounded by the
// hook's own outer timeout, which is 30s for ExitPlanMode and 130s for
// the flush hooks — i.e. the outer hook timeout typically wins).
const DEFAULT_TIMEOUT_MS = 180_000;

// Cap stdout/stderr at 1MB each: a misbehaving bridge that prints a
// multi-MB stack trace would otherwise OOM the host hook process.
// Hooks run in the agent's process tree; OOM there is user-visible.
const MAX_BUFFER_BYTES = 1_048_576;

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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let settled = false;

    const safeKill = () => {
      try { child.kill("SIGKILL"); } catch {}
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("SIGTERM", onParentSigterm);
      process.off("SIGINT", onParentSigterm);
      fn();
    };

    const timer = setTimeout(() => {
      safeKill();
      settle(() =>
        reject(new DifyBridgeUnavailable(`docker exec ${subcommand} timed out after ${timeoutMs}ms`)),
      );
    }, timeoutMs);

    // If the parent (the hook) is killed by Claude Code's outer hook
    // timeout, propagate the kill to the docker exec child so we do NOT
    // leak a stale `docker exec` waiting indefinitely on a now-orphaned
    // pipe. The bridge subprocess inside the container may still finish
    // its in-flight call, but at least the host-side client exits.
    const onParentSigterm = () => {
      safeKill();
      settle(() =>
        reject(new DifyBridgeUnavailable(`docker exec ${subcommand} cancelled by parent signal`)),
      );
    };
    process.once("SIGTERM", onParentSigterm);
    process.once("SIGINT", onParentSigterm);

    const collect = (buf, chunk, which) => {
      if (overflowed) return;
      buf.push(chunk);
      const next = which === "stdout" ? (stdoutBytes += chunk.length) : (stderrBytes += chunk.length);
      if (next > MAX_BUFFER_BYTES) {
        overflowed = true;
        safeKill();
        settle(() =>
          reject(
            new DifyBridgeUnavailable(
              `memory-cli ${subcommand} ${which} exceeded ${MAX_BUFFER_BYTES} bytes; aborting`,
            ),
          ),
        );
      }
    };
    child.stdout.on("data", (c) => collect(stdout, c, "stdout"));
    child.stderr.on("data", (c) => collect(stderr, c, "stderr"));
    child.on("error", (err) => {
      settle(() => reject(new DifyBridgeUnavailable(`docker exec failed to start: ${err.message}`)));
    });
    child.on("close", (code) => {
      if (settled) return;
      const out = Buffer.concat(stdout).toString("utf8");
      const errOut = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        settle(() =>
          reject(
            new DifyBridgeUnavailable(`memory-cli ${subcommand} exited ${code}: ${errOut.trim() || out.trim()}`),
          ),
        );
        return;
      }
      settle(() => {
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new DifyBridgeUnavailable(`memory-cli ${subcommand} returned non-JSON: ${out.slice(0, 300)}`));
        }
      });
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
