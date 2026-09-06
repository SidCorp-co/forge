import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { formatDeprecationHeader } from './deprecation.js';
import { createMcpServer } from './server.js';

export async function mcpHandler(c: Context<{ Variables: PrincipalVars }>): Promise<Response> {
  const principal = c.get('principal');
  const projectSlug = c.req.header('x-forge-project-slug') ?? null;
  // cm:why threaded so the effective-project resolver and metaProjectId() share one answer — a project-level PAT carries its bound project, and resolving it twice is how the two disagree (ISS-497)
  const boundProjectId = principal.boundProjectId;
  const requestId = c.req.header('x-request-id') ?? c.req.header('cf-ray') ?? crypto.randomUUID();
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;

  // cm:edge protocol -> packages/core/src/mcp/deprecation.ts — a shim factory pushes its own legacy name here DURING the call, and this set is only read after the transport has produced its `Response`; attaching `X-MCP-Deprecation` any earlier means attaching it before the handler that would populate it has run (ISS-145)
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
