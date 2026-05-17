import type { McpServerConfig } from "@/lib/types";

export function isRemote(s: McpServerConfig) {
  return s.type === "http" || s.type === "sse" || !!s.url;
}

export function serverSubtitle(s: McpServerConfig) {
  if (isRemote(s)) return s.url ?? "Remote MCP";
  return [s.command, ...(s.args ?? [])].join(" ");
}

export function isForgeServer(name: string, url?: string): boolean {
  if (name === "forge") return true;
  if (url && /\/mcp\/?$/.test(url)) return true;
  return false;
}

/**
 * Build the header set the row uses when talking to a remote MCP. Mirrors
 * the inline merge that `mcp-server-list.tsx` does for the Forge built-in
 * row; exported here so the connection-status panel and the per-row hooks
 * can share the same shape.
 */
export function targetHeaders(
  server: McpServerConfig,
  deviceToken: string | null,
  projectSlug: string | undefined,
  sentryProject: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...(server.headers ?? {}) };
  if (deviceToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${deviceToken}`;
  }
  if (projectSlug && !headers["X-Forge-Project-Slug"]) {
    headers["X-Forge-Project-Slug"] = projectSlug;
  }
  if (sentryProject && !headers["X-Sentry-Project"]) {
    headers["X-Sentry-Project"] = sentryProject;
  }
  return headers;
}

/**
 * Redact secrets for display. Authorization keeps only the last 4 chars of
 * the token; X-Device-Token is masked entirely. All other headers pass
 * through unchanged so the user can still verify project slug, Sentry
 * project, etc.
 */
export function previewHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === "authorization") {
      const tail = v.slice(-4);
      out[k] = `Bearer ••••${tail}`;
    } else if (k.toLowerCase() === "x-device-token") {
      out[k] = "••••";
    } else {
      out[k] = v;
    }
  }
  return out;
}
