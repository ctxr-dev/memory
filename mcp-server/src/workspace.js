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
