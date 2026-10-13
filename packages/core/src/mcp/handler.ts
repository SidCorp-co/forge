import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { describeOperation, empty, json, raw } from '../api-reference/describe.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { formatDeprecationHeader } from './deprecation.js';
import { createMcpServer } from './server.js';

/** What the MCP transport itself answers when it refuses a request: JSON-RPC, never the error envelope. */
const jsonRpcErrorSchema = z.object({
  jsonrpc: z.literal('2.0'),
  error: z.object({ code: z.number().int(), message: z.string() }),
  id: z.null(),
});

const MALFORMED = json(
  jsonRpcErrorSchema,
  'The body is not valid JSON-RPC, or the protocol version is unsupported',
);
const BAD_ORIGIN = json(jsonRpcErrorSchema, 'The Host or Origin header is refused');
const NOT_ACCEPTABLE = json(jsonRpcErrorSchema, 'The Accept header does not list what is needed');

const mcpPost = describeOperation({
  summary: 'Send a JSON-RPC message to the Forge MCP server',
  description:
    'A personal access token is required. Each request is answered on its own, with no session: `initialize`, `tools/list` and `tools/call` all arrive as JSON-RPC and are answered as JSON. `Accept` must list both `application/json` and `text/event-stream`. A message that is only a notification or a response is answered 202 with no body. `X-Forge-Project-Slug` binds the call to a project.',
  responses: {
    200: raw('application/json', 'The JSON-RPC response'),
    202: empty('The message needed no answer'),
    400: MALFORMED,
    403: BAD_ORIGIN,
    406: NOT_ACCEPTABLE,
    413: json(jsonRpcErrorSchema, 'The message is over the size limit'),
    415: json(jsonRpcErrorSchema, 'The Content-Type is not application/json'),
  },
});

const mcpStream = describeOperation({
  summary: 'Open the server-to-client event stream of the Forge MCP server',
  description: 'A personal access token is required. `Accept` must list `text/event-stream`.',
  responses: {
    200: raw('text/event-stream', 'Server-sent events'),
    403: BAD_ORIGIN,
    406: NOT_ACCEPTABLE,
  },
});

const mcpClose = describeOperation({
  summary: 'End an MCP session',
  description:
    'A personal access token is required. Requests are answered without a session, so there is nothing held to end.',
  responses: { 200: empty('Closed'), 403: BAD_ORIGIN },
});

export async function mcpHandler(c: Context<{ Variables: PrincipalVars }>): Promise<Response> {
  const principal = c.get('principal');
  const projectSlug = c.req.header('x-forge-project-slug') ?? null;
  const boundProjectId = principal.boundProjectId;
  const requestId = c.req.header('x-request-id') ?? c.req.header('cf-ray') ?? crypto.randomUUID();
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;

  const deprecations = new Set<string>();
  const server = createMcpServer({
    principal,
    projectSlug,
    boundProjectId,
    requestId,
    ip,
    userAgent,
    deprecations,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  server.onerror = (err) => {
    console.error('[@forge/core mcp] server error:', err);
  };
  transport.onerror = (err) => {
    console.error('[@forge/core mcp] transport error:', err);
  };

  await server.connect(transport);

  try {
    const res = await transport.handleRequest(c.req.raw);
    if (deprecations.size === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('X-MCP-Deprecation', formatDeprecationHeader(deprecations));
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } finally {
    void transport.close();
    void server.close();
  }
}

/** Mounted at `/mcp` once, so each method carries its own description. */
export const mcpRoutes = new Hono<{ Variables: PrincipalVars }>()
  .post('/', mcpPost, mcpHandler)
  .get('/', mcpStream, mcpHandler)
  .delete('/', mcpClose, mcpHandler);
