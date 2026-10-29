import { MCP_OAUTH_CONSENT_PATH, MCP_OAUTH_SCOPES } from '@forge/contracts/mcp-auth';
import { type Context, Hono } from 'hono';
import { env } from '../lib/env.js';
import { reachedOrigin } from '../lib/reached-origin.js';
import { noQuery } from '../middleware/zod-validator.js';

/**
 * What an MCP client reads to find where to sign in. A 401 from `/mcp` names the protected-resource
 * document (RFC 9728), which names this core as the authorization server, whose document (RFC 8414)
 * names the endpoints. The issuer is the origin the client reached, since a client compares the
 * two; the consent page is the web's, at APP_BASE_URL.
 */

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';

/** The protected-resource document's URL, which a 401 from `/mcp` carries as `resource_metadata`. */
export const resourceMetadataUrl = (c: Context) =>
  `${reachedOrigin(c)}${PROTECTED_RESOURCE_PATH}/mcp`;

const noCache = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };

function protectedResource(c: Context) {
  const origin = reachedOrigin(c);
  return c.json(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: MCP_OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
      resource_name: 'Forge',
    },
    200,
    noCache,
  );
}

function authorizationServer(c: Context) {
  const origin = reachedOrigin(c);
  const web = env.APP_BASE_URL.replace(/\/+$/, '');
  return c.json(
    {
      issuer: origin,
      authorization_endpoint: `${web}${MCP_OAUTH_CONSENT_PATH}`,
      token_endpoint: `${origin}/api/mcp-auth/token`,
      registration_endpoint: `${origin}/api/mcp-auth/register`,
      scopes_supported: MCP_OAUTH_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    },
    200,
    noCache,
  );
}

export const mcpOauthMetadataRoutes = new Hono();

// RFC 9728 §3.1 inserts the resource's path after the well-known name; a client that does not
// knows only the bare name, so both answer
mcpOauthMetadataRoutes.get(PROTECTED_RESOURCE_PATH, noQuery, protectedResource);
mcpOauthMetadataRoutes.get(`${PROTECTED_RESOURCE_PATH}/mcp`, noQuery, protectedResource);
mcpOauthMetadataRoutes.get(AUTHORIZATION_SERVER_PATH, noQuery, authorizationServer);
