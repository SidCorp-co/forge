import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import type { McpContext } from '../lib/tool.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { createMcpServer } from './server.js';

function mcpContextOf(c: Context<{ Variables: PrincipalVars }>): McpContext {
  const principal = c.get('principal');
  return {
    principal,
    projectSlug: c.req.header('x-forge-project-slug') ?? null,
    boundProjectId: principal.boundProjectId,
    requestId: c.req.header('x-request-id') ?? c.req.header('cf-ray') ?? crypto.randomUUID(),
    ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}

const logError = (where: string) => (err: Error) => {
  console.error(`[@forge/core mcp] ${where} error:`, err);
};

function buildServer(ctx: McpContext) {
  const server = createMcpServer(ctx);
  server.onerror = logError('server');
  return server;
}

/** The caller of the request the modern handler is serving; its factory builds a server for it. */
const servedCaller = new AsyncLocalStorage<McpContext>();

/**
 * The 2026-07-28 leg, one per process: the SDK's handler owns the per-request envelope,
 * `server/discover` and `subscriptions/listen`, whose streams outlive the request that opened them,
 * so it is never torn down per request. 2025 serving is off here; `mcpHandler` routes it.
 */
const modern = createMcpHandler(
  () => {
    const ctx = servedCaller.getStore();
    if (!ctx)
      throw new Error(
        'mcp: a 2026-07-28 request reached the server factory outside mcpHandler, with no caller to build a server for',
      );
    return buildServer(ctx);
  },
  { legacy: 'reject', onerror: logError('transport') },
);

/**
 * Serves one POST /mcp, statelessly, from a server built for the caller `requirePat` admitted.
 *
 * The SDK classifies the request ({@link isLegacyRequest} is the step `createMcpHandler` routes on).
 * A 2026-07-28 request — the per-request `_meta` envelope, `server/discover` among them — goes to
 * the SDK's handler. A 2025-era one (`initialize`, then calls under 2025-11-25, 2025-06-18 or
 * 2025-03-26) is served by the streamable HTTP transport with no session and a JSON answer, as /mcp
 * has always answered it; the SDK's own stateless fallback would stream every answer as SSE. One
 * server factory backs both, so the two eras list and call the same tools.
 */
export async function mcpHandler(c: Context<{ Variables: PrincipalVars }>): Promise<Response> {
  const ctx = mcpContextOf(c);
  if (!(await isLegacyRequest(c.req.raw))) {
    return servedCaller.run(ctx, () => modern.fetch(c.req.raw));
  }

  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  transport.onerror = logError('transport');
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void transport.close();
    void server.close();
  }
}

/**
 * GET and DELETE /mcp: the 2025 session operations (a standalone event stream, a session's end). A
 * stateless endpoint holds no session, so both answer 405 naming POST, the one method it serves;
 * answering GET with a stream that closed at once had clients reopening it every second or so.
 */
export function mcpMethodNotAllowed(c: Context): Response {
  return c.json(
    {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: `Method not allowed: /mcp is stateless and serves POST only; ${c.req.method} opens or ends a session it does not hold.`,
      },
      id: null,
    },
    405,
    { Allow: 'POST' },
  );
}
