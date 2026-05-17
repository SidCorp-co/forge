import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { Device } from '../auth/deviceToken.js';
import type { PrincipalVars } from '../middleware/require-pat-or-device.js';
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
    lastSeenAt: null,
    pairedAt: new Date(0),
    capabilities: null,
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
  const requestId =
    c.req.header('x-request-id') ?? c.req.header('cf-ray') ?? crypto.randomUUID();
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;

  const server = createMcpServer({
    principal,
    device,
    projectSlug,
    requestId,
    ip,
    userAgent,
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
    return await transport.handleRequest(c.req.raw);
  } finally {
    void transport.close();
    void server.close();
  }
}
