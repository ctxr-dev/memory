import { spawn } from "node:child_process";
import { envValue } from "./env.mjs";
import { augmentSpawnEnv } from "../../mcp-server/src/cron-path.mjs";

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
    throw new DifyBridgeUnavailable("MCP_CONTAINER_NAME not set in the canonical settings/.env");
  }
  return name;
}

// Pure function: build the `docker exec` args array for a given
// subcommand + flags + container name. Exported for unit tests so each
// thin wrapper can be parametrically locked on its subcommand name and
// flag shape without spawning Docker. Flags with value undefined/null/""
// are dropped (matches the bridge CLI's "absent flag = use default"
// contract). Flags with value === true are emitted as a bare `--flag`
// (no value), matching the boolean-switch convention used by the
// memory-cli enable/disable/etc. subcommands.
//
// String values are emitted in the joined `--key=value` form (one argv
// element) rather than the two-element `--key value` form. This is the
// only unambiguous way to pass a value that itself starts with `--`: e.g.
// a dedup search query for a daily atom titled "--dry-run --force wiped
// state" would, in two-element form, be read by the bridge's parser as a
// valueless `--query` flag (the value token starts with `--`, so it looks
// like the next flag), making the bridge reject the call with
// "--query <string> is required" and aborting the whole hourly compile.
// The bridge parseArgs accepts both forms; the `=` form removes the
// ambiguity for every flag, not just query.
export function buildExecCliArgs(subcommand, flags = {}, container) {
  const args = ["exec", "-i", container, "node", "src/memory-cli.js", subcommand];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === "") continue;
    if (value === true) {
      args.push(`--${key}`);
    } else {
      args.push(`--${key}=${String(value)}`);
    }
  }
  return args;
}

async function execCli(subcommand, flags = {}, { stdin, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const container = containerName();
  const args = buildExecCliArgs(subcommand, flags, container);

  return new Promise((resolve, reject) => {
    // Heal the child PATH so `docker` resolves under launchd/cron's minimal PATH
    // (the bridge transport is `docker exec`); a no-op dedup in an interactive
    // shell where docker is already on PATH.
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], env: augmentSpawnEnv(process.env) });
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
    //
    // Load-bearing contract: registering ANY listener for SIGTERM
    // suppresses Node's default exit behavior on that signal, so every
    // call site that uses execCli MUST exit explicitly via process.exit
    // after handling the rejection. Both flush.mjs and exit-plan-mode.mjs
    // do this. settle() removes the listener so a successful call doesn't
    // leak it. Concurrent execCli calls each register their own once()
    // listener; with many parallel calls Node may print
    // MaxListenersExceededWarning above the default 10 — currently no
    // call site does that, but bump process.setMaxListeners(N) here if
    // a future caller needs it.
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
  const isPlainObject =
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (Object.getPrototypeOf(metadata) === Object.prototype || Object.getPrototypeOf(metadata) === null);
  if (isPlainObject && Object.keys(metadata).length > 0) {
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

// Symmetric counterpart to disableDocument. Calls the bridge's `enable`
// CLI subcommand (PATCHes Dify's /documents/status/enable). Closes the
// host-side asymmetry that round-26 created when the MCP tool
// `enable_document` shipped without a matching CLI subcommand.
export function enableDocument({ documentId, datasetId } = {}) {
  return execCli("enable", { documentId, datasetId });
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

// Direct exact-name lookup (server-side), returning { document } or a null
// document. Cheaper and tighter than listing by keyword then filtering.
export function findByName({ name, datasetId } = {}) {
  return execCli("find-by-name", { name, datasetId });
}

export function searchMemoryFiltered({ query, datasetId, limit, filters, scoreThreshold } = {}) {
  // An empty/whitespace query is meaningless for retrieval (nothing to match) AND
  // the bridge's `search` subcommand rejects it ("--query <string> is required").
  // execCli maps that non-zero exit to DifyBridgeUnavailable, so a caller-side
  // empty query (e.g. compile dedup on an atom with no title/tags, or consolidate
  // similarity on an empty-body doc) was misread as a provider outage and aborted
  // the whole hourly run. Short-circuit to "no results" without a bridge round-trip.
  if (!query || String(query).trim() === "") return Promise.resolve({ records: [] });
  const flags = { query, datasetId, limit };
  if (filters && typeof filters === "object") flags.filters = JSON.stringify(filters);
  if (scoreThreshold != null) flags.scoreThreshold = String(scoreThreshold);
  return execCli("search", flags);
}

export function setBuiltInMetadata({ datasetId, enabled } = {}) {
  return execCli("set-built-in-metadata", { datasetId, enabled: String(enabled !== false) });
}

// replace:true asserts `metadata` is the COMPLETE custom-metadata set (skip the
// bridge-side read-merge). Use it only when the caller already holds every field
// (a freshly-created doc, or an engine that merged in memory); omit it otherwise
// so existing fields are preserved (Dify's metadata POST replaces the full set).
export function updateDocMetadata({ datasetId, documentId, metadata, replace } = {}) {
  const flags = { datasetId, documentId };
  if (metadata && typeof metadata === "object") flags.metadata = JSON.stringify(metadata);
  // Require a strict boolean true: emitting --replace skips the bridge read-merge
  // (destructive full-set write), so a truthy non-boolean leaking in from config /
  // CLI plumbing (e.g. the string "false") must NOT enable it.
  if (replace === true) flags.replace = true;
  return execCli("update-doc-metadata", flags);
}

export function listDatasets() {
  return execCli("list-datasets", {});
}

export function listMetadataFields({ datasetId } = {}) {
  return execCli("list-metadata-fields", { datasetId });
}

export function createMetadataField({ datasetId, name, type } = {}) {
  return execCli("create-metadata-field", { datasetId, name, type: type || "string" });
}

// Consolidate working-set listing: every document in a dataset (enabled AND
// disabled) with its flattened per-doc metadata + created_at + enabled flag.
// The plain `list` subcommand omits metadata, which the consolidate
// orchestrator needs (atom_type / error_pattern / stale / created_at) to group
// and age documents. Bodies are NOT included (fetched lazily per surviving
// candidate via readDocument).
export function listForConsolidate({ datasetId } = {}) {
  return execCli("list-consolidate", { datasetId });
}
