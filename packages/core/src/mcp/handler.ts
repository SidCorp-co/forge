import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { Device } from '../auth/deviceToken.js';
import type { PrincipalVars } from '../middleware/require-pat-or-device.js';
import { formatDeprecationHeader } from './deprecation.js';
import { createMcpServer } from './server.js';

/**
 * Build a stub Device row from a PAT principal so legacy device-only tool
 * factories keep working. The stub never reaches the DB — it's a transient
 * object scoped to one request. Membership helpers (`assertDeviceOwnerIsMember`)
 * only read `ownerId`, which we set to the PAT user's id. Helpers that
 * pivot on the device's `id` (e.g. `assertPmActor` joining `runners`) will
 * naturally find no matching row, which is correct: PAT users have no
 * runner to act as.
 */
function stubDeviceForPat(userId: string, tokenId: string): Device {
  return {
    id: tokenId,
    ownerId: userId,
    name: '__pat_synthetic__',
    platform: 'linux',
    agentVersion: null,
    tokenHash: '',
    tokenPrefix: '',
    status: 'online',
    disabledAt: null,
    lastSeenAt: null,
    pairedAt: new Date(0),
    capabilities: null,
    gitCredentialRef: null,
    machineId: null,
    createdAt: new Date(0),
  };
}

export async function mcpHandler(c: Context<{ Variables: PrincipalVars }>): Promise<Response> {
  const principal = c.get('principal');
  const device =
    principal.kind === 'device'
      ? principal.device
      : stubDeviceForPat(principal.userId, principal.tokenId);
  const projectSlug = c.req.header('x-forge-project-slug') ?? null;
  // cm:why threaded so the effective-project resolver and metaProjectId() share one answer — a project-level PAT carries its bound project, and resolving it twice is how the two disagree (ISS-497)
  const boundProjectId = principal.kind === 'pat' ? principal.boundProjectId : null;
  const requestId = c.req.header('x-request-id') ?? c.req.header('cf-ray') ?? crypto.randomUUID();
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;

  // cm:edge protocol -> packages/core/src/mcp/deprecation.ts — a shim factory pushes its own legacy name here DURING the call, and this set is only read after the transport has produced its `Response`; attaching `X-MCP-Deprecation` any earlier means attaching it before the handler that would populate it has run (ISS-145)
  const deprecations = new Set<string>();
  const server = createMcpServer({
    principal,
    device,
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
