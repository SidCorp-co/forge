// Settings → MCP helpers. Adapted from web v1 (`features/mcp`) for web-v2.
//
// Two real capabilities, both backed by the live MCP endpoint — there is no
// backend "MCP config" to save, so nothing is faked here:
//  1. Per-client config snippet generation. The token is ALWAYS rendered as the
//     `<YOUR_TOKEN_HERE>` placeholder — we never echo a secret value (the
//     plaintext is only shown once, at creation, on the Tokens tab).
//  2. `testConnection` issues a real JSON-RPC `tools/list` against `/mcp` with a
//     user-supplied token, so a user verifies their setup against the same path
//     a real MCP client uses.

export type ClientKind = "claude-cli" | "cursor" | "cline" | "zed" | "generic";

export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN_HERE>";

export const CLIENTS: ReadonlyArray<{ kind: ClientKind; label: string }> = [
  { kind: "claude-cli", label: "Claude CLI" },
  { kind: "cursor", label: "Cursor" },
  { kind: "cline", label: "Cline" },
  { kind: "zed", label: "Zed" },
  { kind: "generic", label: "Generic" },
];

export interface SnippetInput {
  projectSlug: string;
  mcpUrl: string;
}

export interface Snippet {
  filePath: string;
  content: string;
}

function mcpServersFragment(projectSlug: string, mcpUrl: string) {
  return {
    mcpServers: {
      forge: {
        url: mcpUrl,
        headers: {
          Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
          "X-Forge-Project-Slug": projectSlug,
        },
      },
    },
  };
}

function format(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Resolve the MCP endpoint. `/mcp` is served by core, NOT the web origin, so
 *  we anchor it at the core API origin the same way `apiClient` derives
 *  `CORE_URL` (`NEXT_PUBLIC_API_URL` minus the `/api` suffix). On the
 *  cross-origin forge-beta deploy this yields the API host (e.g.
 *  `https://forge-beta-api.sidcorp.co/mcp`) instead of the 404-ing web host.
 *  When `NEXT_PUBLIC_API_URL` is unset/relative (same-origin `/v2` deploy,
 *  local dev), core shares the browser origin, so fall back to it. */
export function getMcpUrl(): string {
  const coreUrl = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/api\/?$/, "");
  if (coreUrl) return `${coreUrl}/mcp`;
  if (typeof window === "undefined") return "/mcp";
  return `${window.location.origin}/mcp`;
}

export function generateSnippet(kind: ClientKind, input: SnippetInput): Snippet {
  switch (kind) {
    case "claude-cli":
      return {
        filePath: "~/.claude/settings.json",
        content: format(mcpServersFragment(input.projectSlug, input.mcpUrl)),
      };
    case "cursor":
      return {
        filePath: ".cursor/mcp.json",
        content: format(mcpServersFragment(input.projectSlug, input.mcpUrl)),
      };
    case "cline":
      return {
        filePath: "cline_mcp_settings.json",
        content: format(mcpServersFragment(input.projectSlug, input.mcpUrl)),
      };
    case "zed":
      return {
        filePath: "~/.config/zed/settings.json",
        content: format({
          context_servers: {
            forge: {
              command: { url: input.mcpUrl },
              headers: {
                Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
                "X-Forge-Project-Slug": input.projectSlug,
              },
            },
          },
        }),
      };
    case "generic":
      return {
        filePath: "mcp.json",
        content: format(mcpServersFragment(input.projectSlug, input.mcpUrl)),
      };
  }
}

export class McpTestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "McpTestError";
    this.status = status;
    this.code = code;
  }
}

export interface TestConnectionResult {
  toolsCount: number;
  sampleNames: string[];
}

interface JsonRpcResponse {
  result?: { tools?: Array<{ name?: unknown }> };
  error?: { message?: string; data?: { code?: string } };
}

async function parseError(res: Response): Promise<McpTestError> {
  let code: string | null = null;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as {
      code?: string;
      message?: string;
      error?: { code?: string; message?: string };
    };
    if (body && typeof body === "object") {
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
      if (body.error) {
        if (code === null && typeof body.error.code === "string") code = body.error.code;
        if (typeof body.error.message === "string") message = body.error.message;
      }
    }
  } catch {
    // non-JSON error body — keep the statusText fallback
  }
  return new McpTestError(res.status, code, message);
}

/** Live MCP smoke test: JSON-RPC `tools/list` with the user's PAT. The token is
 *  supplied per-call by the user and is never stored or echoed back. */
export async function testConnection(input: {
  url: string;
  token: string;
  projectSlug: string;
}): Promise<TestConnectionResult> {
  const res = await fetch(input.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Streamable-HTTP transport requires advertising both framings or core
      // rejects with HTTP 406.
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${input.token}`,
      "X-Forge-Project-Slug": input.projectSlug,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

  if (!res.ok) throw await parseError(res);

  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) {
    const code = typeof body.error.data?.code === "string" ? body.error.data.code : null;
    throw new McpTestError(200, code, body.error.message ?? "MCP error");
  }

  const tools = body.result?.tools ?? [];
  const sampleNames = tools
    .map((t) => (typeof t?.name === "string" ? t.name : null))
    .filter((n): n is string => n !== null)
    .slice(0, 5);

  return { toolsCount: tools.length, sampleNames };
}
