/**
 * MCP "Test Connection" — calls the running MCP endpoint directly from the
 * browser using the user's PAT, so a user verifying their setup gets the same
 * response a real MCP client would. We send a JSON-RPC `tools/list` request
 * and surface the count + first five tool names.
 *
 * Errors throw `McpTestError` with the HTTP status and (when available) the
 * `error.code` parsed from the response body — the UI uses both to render an
 * actionable message (e.g. "401 PAT_REVOKED").
 */

export interface TestConnectionInput {
  url: string;
  token: string;
  projectSlug: string;
}

export interface TestConnectionResult {
  toolsCount: number;
  sampleNames: string[];
}

export class McpTestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = 'McpTestError';
    this.status = status;
    this.code = code;
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: { tools?: Array<{ name?: unknown }> };
  error?: { code?: number | string; message?: string; data?: { code?: string } };
}

async function parseError(res: Response): Promise<McpTestError> {
  let code: string | null = null;
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body && typeof body === 'object' && body.error) {
      if (typeof body.error.code === 'string') code = body.error.code;
      if (typeof body.error.message === 'string') message = body.error.message;
    }
  } catch {
    // ignore — non-JSON error body
  }
  return new McpTestError(res.status, code, message);
}

export async function testConnection({
  url,
  token,
  projectSlug,
}: TestConnectionInput): Promise<TestConnectionResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-Forge-Project-Slug': projectSlug,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }),
  });

  if (!res.ok) throw await parseError(res);

  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) {
    const code = typeof body.error.data?.code === 'string' ? body.error.data.code : null;
    throw new McpTestError(200, code, body.error.message ?? 'MCP error');
  }

  const tools = body.result?.tools ?? [];
  const sampleNames = tools
    .map((t) => (typeof t?.name === 'string' ? t.name : null))
    .filter((n): n is string => n !== null)
    .slice(0, 5);

  return { toolsCount: tools.length, sampleNames };
}
