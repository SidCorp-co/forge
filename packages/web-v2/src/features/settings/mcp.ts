import { CORE_URL } from "@/lib/utils/core-url";

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

export const CLIENTS: { value: ClientKind; label: string }[] = [
  { value: "claude-cli", label: "Claude CLI" },
  { value: "cursor", label: "Cursor" },
  { value: "cline", label: "Cline" },
  { value: "zed", label: "Zed" },
  { value: "generic", label: "Generic" },
];

interface SnippetInput {
  projectSlug: string;
  mcpUrl: string;
}

/** A snippet is either pasted into a file the client reads, or run once in a terminal. */
type Snippet =
  | { howTo: "file"; filePath: string; content: string }
  | { howTo: "command"; content: string };

function forgeHeaders(projectSlug: string) {
  return { Authorization: `Bearer ${TOKEN_PLACEHOLDER}`, "X-Forge-Project-Slug": projectSlug };
}

function format(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** `/mcp` is served by core, NOT the web origin, so anchor it at the core API
 *  origin (the cross-origin beta deploy would 404 on the web host). When core
 *  shares the browser origin (`CORE_URL` empty), fall back to it. */
export function getMcpUrl(): string {
  if (CORE_URL) return `${CORE_URL}/mcp`;
  if (typeof window === "undefined") return "/mcp";
  return `${window.location.origin}/mcp`;
}

const MCP_JSON_PATH: Record<"cursor" | "cline" | "generic", string> = {
  cursor: "~/.cursor/mcp.json",
  cline: "cline_mcp_settings.json",
  generic: "mcp.json",
};

export function generateSnippet(kind: ClientKind, input: SnippetInput): Snippet {
  switch (kind) {
    case "claude-cli":
      return {
        howTo: "command",
        content:
          `claude mcp add --transport http --scope user forge ${input.mcpUrl}` +
          ` --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"` +
          ` --header "X-Forge-Project-Slug: ${input.projectSlug}"\n`,
      };
    case "zed":
      return {
        howTo: "file",
        filePath: "~/.config/zed/settings.json",
        content: format({
          context_servers: {
            forge: {
              command: { url: input.mcpUrl },
              headers: forgeHeaders(input.projectSlug),
            },
          },
        }),
      };
    default:
      return {
        howTo: "file",
        filePath: MCP_JSON_PATH[kind],
        content: format({
          mcpServers: { forge: { url: input.mcpUrl, headers: forgeHeaders(input.projectSlug) } },
        }),
      };
  }
}

export class McpTestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "McpTestError";
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

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

async function parseError(res: Response): Promise<McpTestError> {
  // A non-JSON error body keeps the statusText fallback.
  type ErrorBody = { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } };
  const raw = (await res.json().catch(() => null)) as ErrorBody | null;
  const body: ErrorBody = raw && typeof raw === "object" ? raw : {};
  return new McpTestError(
    res.status,
    str(body.code) ?? str(body.error?.code) ?? null,
    str(body.error?.message) ?? str(body.message) ?? (res.statusText || `HTTP ${res.status}`),
  );
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
  if (body.error) throw new McpTestError(200, str(body.error.data?.code) ?? null, body.error.message ?? "MCP error");

  const tools = body.result?.tools ?? [];
  const sampleNames = tools.flatMap((t) => str(t?.name) ?? []).slice(0, 5);
  return { toolsCount: tools.length, sampleNames };
}
