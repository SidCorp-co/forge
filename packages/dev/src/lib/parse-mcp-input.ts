import type { McpServerConfig } from "./types";

/**
 * Parse user input text into MCP server config(s).
 * Supports JSON, URL, and CLI command formats.
 */
export function parseMcpInput(
  text: string,
): Record<string, McpServerConfig> {
  const trimmed = text.trim();
  if (!trimmed) return {};

  // 1. Try JSON
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      // Unwrap {"mcpServers": {...}} wrapper
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        return parsed.mcpServers as Record<string, McpServerConfig>;
      }
      // Direct server configs: each value should have "command" or "type"
      const keys = Object.keys(parsed);
      if (
        keys.length > 0 &&
        keys.every((k) => {
          const v = parsed[k];
          return (
            typeof v === "object" &&
            v !== null &&
            ("command" in v || "type" in v)
          );
        })
      ) {
        return parsed as Record<string, McpServerConfig>;
      }
    }
  } catch {
    // Not JSON, continue
  }

  // 2. Try URL
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const name = url.hostname.replace(/\./g, "-");
      return { [name]: { type: "http", url: trimmed } };
    } catch {
      // Invalid URL, continue
    }
  }

  // 3. Try CLI command
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 1) {
    const command = parts[0];
    const args = parts.slice(1);

    // Extract package name: last arg starting with @, or last arg
    let pkgName = "mcp-server";
    for (let i = args.length - 1; i >= 0; i--) {
      if (args[i].startsWith("@")) {
        pkgName = args[i].replace(/\//g, "-").replace(/^@/, "");
        break;
      }
      if (i === args.length - 1) {
        // Use last arg as fallback name
        const last = args[i].split("/").pop() || args[i];
        pkgName = last.replace(/\//g, "-");
      }
    }

    return { [pkgName]: { command, args } };
  }

  return {};
}
