// Shared workspace-mount constants. Both `index.js` (MCP server entry)
// and `memory-cli.js` (CLI dispatcher) need to know where the
// `compose.mcp.yaml` bind-mounted the host workspace inside the bridge
// container, and how much of a single file to read on absorb.
//
// Round-33 extracted these out of the two consumer files which had
// silently duplicated env reads + defaults with subtly different local
// variable names. Single source of truth eliminates the drift class.

export const WORKSPACE_MOUNT = process.env.WORKSPACE_MOUNT || "/workspace";

const parsedAbsorbMaxFileBytes = Number.parseInt(process.env.ABSORB_MAX_FILE_BYTES || "", 10);
export const ABSORB_MAX_FILE_BYTES =
  Number.isFinite(parsedAbsorbMaxFileBytes) && parsedAbsorbMaxFileBytes > 0
    ? parsedAbsorbMaxFileBytes
    : 500_000;

// Best-effort host-workspace identifier for use as a default
// `project_module` filter on recall_lessons / search_memory when the
// caller didn't pass one explicitly. Picked from the bridge container's
// env in priority order:
//
// 1. `MEMORY_DEFAULT_PROJECT_MODULE` — explicit user override.
// 2. `COMPOSE_PROJECT_NAME` — bootstrap.sh writes this into ./.memory/settings/.env
//    derived from the host workspace basename, so it survives container
//    restarts and is the most reliable signal.
//
// Returns `""` (not `null`) when nothing usable is available. Callers
// must treat empty string as "no default, do not inject" — passing it
// downstream as a filter value would scope retrieval to docs with an
// empty project_module which is the opposite of intent.
//
// Normalisation: lowercased and trimmed; no other transformation. We
// deliberately do NOT slugify here (hyphen / underscore mapping) because
// the user authored project_module values in save_lesson / save_to_dataset
// calls are taken verbatim; mismatched normalisation would silently
// scope the recall to an unrelated module.
export function inferDefaultProjectModule(env = process.env) {
  // Defensive: caller may explicitly pass `null` (e.g. in tests) instead
  // of relying on the default. Treat as "no env" → return empty string.
  if (!env || typeof env !== "object") return "";
  const explicit = String(env.MEMORY_DEFAULT_PROJECT_MODULE || "").trim().toLowerCase();
  if (explicit) return explicit;
  const compose = String(env.COMPOSE_PROJECT_NAME || "").trim().toLowerCase();
  // bootstrap.sh writes placeholders like `__compose_project_name__` into
  // ./.memory/settings/.env before substituting real values. If bootstrap was
  // interrupted (CTRL-C, error mid-script) the literal placeholder may
  // survive and forward into the container. Treat any `__...__`-shaped
  // value as "not actually configured" so we don't poison recall scoping
  // with a fake project_module shared across all broken installs.
  if (compose.startsWith("__") && compose.endsWith("__")) return "";
  return compose;
}

export const DEFAULT_PROJECT_MODULE = inferDefaultProjectModule();

// Compute the `injectedFilters` envelope field surfaced by recall_lessons
// + search_memory. Returns null when no filter was auto-injected; returns
// `{ project_module: <value> }` when the bridge applied the workspace
// identifier because the caller omitted project_module.
//
// Used by both recall_lessons (which always injects if caller omitted
// project_module and DEFAULT is bound) and search_memory (which injects
// only when caller passed a filters object without project_module —
// passing no filters at all is treated as "search every project").
//
// The `mode` parameter distinguishes the two: "recall" matches recall_lessons
// semantics (inject when caller omits project_module); "search" matches
// search_memory semantics (inject only when caller passed filters but
// omitted project_module).
export function computeInjectedFilters({ mode, callerProjectModule, callerFilters, effectiveProjectModule }) {
  if (mode === "recall") {
    if (!callerProjectModule && effectiveProjectModule) {
      return { project_module: effectiveProjectModule };
    }
    return null;
  }
  if (mode === "search") {
    if (callerFilters && !callerFilters.project_module && effectiveProjectModule) {
      return { project_module: effectiveProjectModule };
    }
    return null;
  }
  return null;
}
