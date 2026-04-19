import type { ForgeTool, ForgeToolContext } from './tools';

interface McpServerConfig {
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  auth?: {
    type?: string;
    tokenFrom?: string; // 'hubToken' = use caller's token; otherwise use apiKey
  };
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

let requestId = 0;

function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: '2.0', id: ++requestId, method, params };
}

/**
 * Parse SSE response body to extract JSON-RPC message.
 * SSE format: "event: message\ndata: {...}\n\n"
 */
function parseSSE(text: string): any {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  // Try parsing as plain JSON
  return JSON.parse(text);
}

async function rpcCall(url: string, headers: Record<string, string>, request: JsonRpcRequest, sessionId?: string): Promise<any> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...headers,
  };
  if (sessionId) h['mcp-session-id'] = sessionId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(request),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) throw new Error(`MCP RPC failed: ${res.status} ${res.statusText}`);

  const contentType = res.headers.get('content-type') || '';

  // Read body with a separate timeout for large SSE responses
  const bodyController = new AbortController();
  const bodyTimeout = setTimeout(() => bodyController.abort(), 30_000);
  let rawText: string;
  try {
    rawText = await res.text();
  } finally {
    clearTimeout(bodyTimeout);
  }

  let body: JsonRpcResponse;

  if (contentType.includes('text/event-stream')) {
    body = parseSSE(rawText);
  } else {
    body = JSON.parse(rawText);
  }

  if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  return { result: body.result, sessionId: res.headers.get('mcp-session-id') || sessionId };
}

export async function initMcpSession(url: string, headers: Record<string, string>): Promise<string> {
  const { sessionId } = await rpcCall(url, headers, makeRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'forge-agent', version: '1.0.0' },
  }));

  // Send initialized notification
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  return sessionId || '';
}

export async function listMcpTools(url: string, headers: Record<string, string>, sessionId: string): Promise<any[]> {
  const { result } = await rpcCall(url, headers, makeRequest('tools/list'), sessionId);
  return result?.tools || [];
}

export async function callMcpTool(url: string, headers: Record<string, string>, sessionId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const { result } = await rpcCall(url, headers, makeRequest('tools/call', { name, arguments: args }), sessionId);
  return result;
}

export async function createMcpForgeTools(
  mcpServers: Record<string, McpServerConfig>,
  hubToken?: string,
): Promise<ForgeTool[]> {
  const allTools: ForgeTool[] = [];

  for (const [serverKey, config] of Object.entries(mcpServers)) {
    try {
      const headers: Record<string, string> = { ...(config.headers || {}) };
      // Auth priority: apiKey (service token) first for reliable access,
      // hubToken only when explicitly configured via auth.tokenFrom
      const useHubToken = config.auth?.tokenFrom === 'hubToken';
      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      } else if (hubToken) {
        headers['Authorization'] = `Bearer ${hubToken}`;
      }
      // Pass hubToken as separate header for user context when using apiKey
      if (useHubToken && hubToken && config.apiKey) {
        headers['X-Hub-Token'] = hubToken;
      }

      const sessionId = await initMcpSession(config.url, headers);
      const tools = await listMcpTools(config.url, headers, sessionId);

      for (const tool of tools) {
        const toolName = `${serverKey}__${tool.name}`;
        allTools.push({
          name: toolName,
          description: tool.description || `MCP tool: ${tool.name}`,
          parameters: tool.inputSchema || { type: 'object', properties: {} },
          async execute(input: Record<string, unknown>, _ctx: ForgeToolContext): Promise<string> {
            try {
              const result = await callMcpTool(config.url, headers, sessionId, tool.name, input);
              if (result?.content) {
                return result.content
                  .map((c: any) => c.type === 'text' ? c.text : JSON.stringify(c))
                  .join('\n');
              }
              return JSON.stringify(result);
            } catch (err) {
              return `MCP tool error: ${err}`;
            }
          },
        });
      }
    } catch (err) {
      console.warn(`Failed to init MCP server "${serverKey}": ${err}`);
    }
  }

  return allTools;
}
