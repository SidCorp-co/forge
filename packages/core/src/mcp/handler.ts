import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import { logger } from '../lib/logger.js';
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

/** The first revision negotiated by `server/discover` rather than `initialize`. */
const FIRST_DISCOVERED = '2026-07-28';

type DiscoverResult = { supportedVersions: string[] } & Record<string, unknown>;
type DiscoverSeam = {
  _ondiscover?: () => DiscoverResult;
  _supportedProtocolVersions?: string[];
};

/**
 * `server/discover` naming every revision /mcp serves, the 2026 ones first, where the SDK names only
 * the 2026 ones (2025 clients negotiate by `initialize`). ChatGPT's connector reported "action
 * discovery failed" against the shorter list (ISS-768 r2), and the fix that worked for another server
 * advertised every revision. The SDK answers discover through `Server._ondiscover`, which it does
 * not export; a release that moves it is refused here by name, never served the shorter list.
 */
function advertiseEveryRevision(server: ReturnType<typeof createMcpServer>): void {
  const seam = server as unknown as DiscoverSeam;
  const own = seam._ondiscover;
  if (typeof own !== 'function') {
    throw new Error(
      'mcp: @modelcontextprotocol/server no longer answers server/discover through Server._ondiscover, so /mcp cannot advertise the 2025 revisions it serves beside 2026-07-28; find the hook this SDK release uses (handler.test.ts asserts the advertisement)',
    );
  }
  seam._ondiscover = () => {
    const answer = own.call(server);
    const served = seam._supportedProtocolVersions ?? answer.supportedVersions;
    const discovered = served
      .filter((v) => v >= FIRST_DISCOVERED)
      .sort()
      .reverse();
    const initialized = served.filter((v) => v < FIRST_DISCOVERED);
    return { ...answer, supportedVersions: [...discovered, ...initialized] };
  };
}

function buildServer(ctx: McpContext) {
  const server = createMcpServer(ctx);
  server.onerror = logError('server');
  advertiseEveryRevision(server);
  return server;
}

type RpcMessage = { id?: unknown; method?: unknown; result?: unknown; error?: { code?: unknown } };

/** The JSON-RPC messages in a body: a JSON message or batch, or the `data:` lines of an event stream. */
function messagesIn(text: string): RpcMessage[] {
  const parse = (one: string): RpcMessage[] => {
    try {
      const parsed = JSON.parse(one) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed]).filter(
        (m): m is RpcMessage => typeof m === 'object' && m !== null,
      );
    } catch {
      return [];
    }
  };
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parse(trimmed);
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .flatMap((line) => parse(line.slice(5).trim()));
}

/**
 * One line for one POST /mcp: the JSON-RPC method(s) asked, the protocol version header, what each
 * answer was (`result`, or `error <code>`), how many tools a listing held, and the answer's size.
 * No token, no params, no result body: the line shows where a client stops (ChatGPT authenticated,
 * listed, and reported "action discovery failed" with nothing to say which answer it refused,
 * ISS-768 r2). Read off a copy of the answer, so a stream reaches its client unheld and is logged
 * when it ends.
 */
function logExchange(c: Context, ctx: McpContext, asked: RpcMessage[], res: Response): void {
  const methods = asked.map((m) => (typeof m.method === 'string' ? m.method : null));
  void res
    .clone()
    .text()
    .then((text) => {
      const answers = messagesIn(text).filter((m) => 'result' in m || 'error' in m);
      const tools = answers
        .map((m) => (m.result as { tools?: unknown } | undefined)?.tools)
        .find(Array.isArray);
      logger.info(
        {
          mcp: {
            methods,
            protocolVersion: c.req.header('mcp-protocol-version') ?? null,
            status: res.status,
            results: answers.map((m) =>
              m.error ? `error ${String(m.error.code ?? 'unknown')}` : 'result',
            ),
            tools: tools ? tools.length : null,
            bytes: Buffer.byteLength(text),
            requestId: ctx.requestId,
            userAgent: ctx.userAgent,
          },
        },
        'mcp request',
      );
    })
    .catch((err: unknown) => logger.warn({ err }, 'mcp request: the answer could not be read'));
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
  const asked = messagesIn(await c.req.raw.clone().text());
  const res = await serve(c, ctx);
  logExchange(c, ctx, asked, res);
  return res;
}

async function serve(c: Context<{ Variables: PrincipalVars }>, ctx: McpContext): Promise<Response> {
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
