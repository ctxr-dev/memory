// Install the per-document metadata schema on every BOUND dataset slot.
//
// create_dataset installs the full schema on NEW datasets, and dify-setup.sh
// installs it during a fresh setup. This standalone CLI backfills the schema on
// datasets that ALREADY exist (e.g. after a runtime upgrade adds new fields like
// the consolidate/recall set), without re-running the interactive wizard. It is
// idempotent: a field already present on a slot is skipped.
//
// Run by bootstrap.sh after dependency install, and manually anytime:
//   node scripts/install-metadata-fields.mjs            # do it
//   node scripts/install-metadata-fields.mjs --dry-run  # show the plan only
//   node scripts/install-metadata-fields.mjs --datasetId=knowledge   # one slot
//
// Exit codes:
//   0  success (fields installed or dry-run completed)
//   2  preflight failure (no slots bound / bridge unavailable)
//   3  user error (bad arg)

import path from "node:path";
import { pathToFileURL } from "node:url";

import { readEnvFile } from "./lib/env.mjs";
import { METADATA_SCHEMA } from "./lib/datasets.mjs";
import { boundSlotsFromEnv } from "../mcp-server/src/consolidate-policy.js";
import { listMetadataFields, createMetadataField, DifyBridgeUnavailable } from "./lib/dify-write.mjs";

class InstallError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv) {
  const opts = { dryRun: false, datasetId: null, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg.startsWith("--datasetId=")) opts.datasetId = arg.slice("--datasetId=".length);
    else throw new InstallError(`unknown arg: ${arg}`, 3);
  }
  return opts;
}

// Pure: given the field names currently present on a dataset and the full
// schema, return the schema entries ({name,type}) that are missing. Exported
// for tests.
export function diffMissingFields(currentNames, schema = METADATA_SCHEMA) {
  const present = new Set((currentNames || []).filter(Boolean));
  return schema.filter((f) => !present.has(f.name));
}

// Extract field names from a `list-metadata-fields` bridge response. The Dify
// shape is { doc_metadata: [{ id, name, type }] }.
export function fieldNamesFromResponse(res) {
  const fields = Array.isArray(res?.doc_metadata) ? res.doc_metadata : [];
  return fields.map((f) => f?.name).filter(Boolean);
}

function printHelp() {
  process.stdout.write(`Install the per-document metadata schema on bound dataset slots.

Usage:
  node scripts/install-metadata-fields.mjs [--dry-run] [--datasetId=<slot-or-id>]

Options:
  --dry-run, -n           Print the create plan; do not write.
  --datasetId=<slot|id>   Restrict to a single slot (default: every bound slot).
  --help, -h              This help.

Exit codes:
  0 success   2 preflight failure   3 user error
`);
}

async function installForSlot(slot, { dryRun }) {
  let listed;
  try {
    listed = await listMetadataFields({ datasetId: slot });
  } catch (err) {
    if (err instanceof DifyBridgeUnavailable) throw new InstallError(`bridge unavailable listing '${slot}': ${err.message}`, 2);
    throw err;
  }
  const present = fieldNamesFromResponse(listed);
  const missing = diffMissingFields(present);
  const created = [];
  const failed = [];
  for (const field of missing) {
    if (dryRun) {
      created.push({ name: field.name, type: field.type, dryRun: true });
      continue;
    }
    try {
      await createMetadataField({ datasetId: slot, name: field.name, type: field.type });
      created.push({ name: field.name, type: field.type });
    } catch (err) {
      if (err instanceof DifyBridgeUnavailable) throw new InstallError(`bridge unavailable creating '${field.name}' on '${slot}': ${err.message}`, 2);
      failed.push({ name: field.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { slot, present: present.length, missing: missing.map((f) => f.name), created, failed };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }
  const env = { ...readEnvFile(), ...process.env };
  let slots = boundSlotsFromEnv(env);
  if (opts.datasetId) {
    // Accept a slot name or a raw id; pass through verbatim (the bridge resolves).
    slots = [opts.datasetId];
  }
  if (slots.length === 0) {
    throw new InstallError("no dataset slots bound (no DIFY_DATASET_<NAME>_ID lines in settings/.env). Run dify-setup.sh first.", 2);
  }

  process.stdout.write(`installing metadata schema (${METADATA_SCHEMA.length} fields) on ${slots.length} slot(s)${opts.dryRun ? " [dry-run]" : ""}:\n`);
  let failTotal = 0;
  for (const slot of slots) {
    const r = await installForSlot(slot, opts);
    const verb = opts.dryRun ? "would create" : "created";
    process.stdout.write(`  ${slot}: present=${r.present} ${verb}=${r.created.length}${r.failed.length ? ` failed=${r.failed.length}` : ""}\n`);
    for (const f of r.failed) process.stderr.write(`    failed ${f.name}: ${f.error}\n`);
    failTotal += r.failed.length;
  }
  process.stdout.write(`done. failures=${failTotal}\n`);
  return failTotal === 0 ? 0 : 1;
}

const invokedAsCli = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`install-metadata-fields: ${msg}\n`);
      process.exit(err instanceof InstallError ? err.exitCode : 1);
    });
}

export { InstallError };
