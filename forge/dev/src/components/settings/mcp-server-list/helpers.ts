import type { McpServerConfig } from "@/lib/types";

export function isRemote(s: McpServerConfig) {
  return s.type === "http" || s.type === "sse" || !!s.url;
}

export function serverSubtitle(s: McpServerConfig) {
  if (isRemote(s)) return s.url ?? "Remote MCP";
  return [s.command, ...(s.args ?? [])].join(" ");
}
