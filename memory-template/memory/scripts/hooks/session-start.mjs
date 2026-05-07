const context = [
  "Project memory is available through the `__MEMORY_SERVER_NAME__` MCP server.",
  "Use `search_memory` before relying on project-history assumptions, architecture decisions, integration details, or previous session conclusions.",
  "Use `write_memory` for explicit durable decisions that should be available in future sessions.",
  "Hooks write session memory directly into Dify on `PreCompact`, `PostCompact`, and `SessionEnd` when Dify write env is configured.",
  "Do not create sidecar memory files; Dify is the memory store.",
].join("\n");

console.log(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }),
);
