import {
  MCP_OAUTH_ACCESS_TTL_SECONDS,
  MCP_OAUTH_SCOPES,
  type McpAuthRefusalCode,
  type McpConsentAnswer,
  type McpConsentView,
  type McpOAuthScope,
} from '@forge/contracts/mcp-auth';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { RULES } from '../lib/rate-limits.js';
import { reachedOrigin } from '../lib/reached-origin.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import {
  CODE_CHALLENGE,
  parseScope,
  redirectUriFault,
  redirectUriRegistered,
  redirectWith,
} from './mcp-oauth-shape.js';
import {
  endLapsedGrants,
  findClient,
  issueCode,
  redeemCode,
  refreshGrant,
  registerClient,
  type TokenOutcome,
} from './mcp-oauth-store.js';
import {
  assertFreshAuth,
  assertProjectsVisible,
  assertUnderTokenLimit,
  mintableGrant,
  patMenu,
} from './pat-grant-checks.js';
import { PAT_GRANT_EPOCH } from './pat-permissions.js';

/**
 * MCP OAuth (the MCP authorization spec, on OAuth 2.1): an MCP client registers itself, sends the
 * person to the consent page, and redeems the code the page answers with for an hour-long access
 * token and a rotating refresh token. Mounted at `/api/mcp-auth`; the metadata that points a
 * client here is `mcp-oauth-metadata.ts`.
 *
 * `register` and `token` answer in OAuth's own error shape (`{ error, error_description }`), since
 * their caller is an OAuth client library; `authorize` is the web's, and answers Forge refusals.
 */

const refuse = refuser<McpAuthRefusalCode>('MCP_AUTH_REFUSED');

export const mcpOauthRoutes = new Hono<{ Variables: AuthVars }>();

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status, {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });

// ── Dynamic client registration (RFC 7591) ──────────────────────────────────

const registerBody = z.looseObject({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const GRANT_TYPES = ['authorization_code', 'refresh_token'];

mcpOauthRoutes.post(
  '/register',
  rateLimit(() => RULES.mcpOauthRegister, { name: 'mcpOauthRegister' }),
  zValidator('json', registerBody, (r, c) =>
    r.success
      ? undefined
      : oauthError(
          c,
          'invalid_client_metadata',
          'send redirect_uris (one to ten URLs) and, optionally, client_name (up to 100 characters)',
        ),
  ),
  async (c) => {
    const body = c.req.valid('json');
    const fault = body.redirect_uris.map(redirectUriFault).find((f) => f !== null);
    if (fault) return oauthError(c, 'invalid_redirect_uri', fault);
    const method = body.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') {
      return oauthError(
        c,
        'invalid_client_metadata',
        `token_endpoint_auth_method ${method} is not offered: a client here is public and uses PKCE, so send "none"`,
      );
    }
    const unoffered = (body.grant_types ?? []).find((g) => !GRANT_TYPES.includes(g));
    if (unoffered) {
      return oauthError(
        c,
        'invalid_client_metadata',
        `grant type ${unoffered} is not offered; this server issues ${GRANT_TYPES.join(' and ')}`,
      );
    }
    if ((body.response_types ?? ['code']).some((t) => t !== 'code')) {
      return oauthError(c, 'invalid_client_metadata', 'the only response type offered is code');
    }
    const client = await registerClient({
      clientName: body.client_name ?? 'MCP client',
      redirectUris: body.redirect_uris,
      createdIp: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    });
    return c.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: GRANT_TYPES,
        response_types: ['code'],
      },
      201,
      { 'Cache-Control': 'no-store' },
    );
  },
);

// ── Consent (the web's /oauth/authorize page) ───────────────────────────────

/** The origins this core answers on: the one the request reached, and the two it is configured at. */
function servedOrigins(c: Context): Set<string> {
  const configured = [env.PUBLIC_API_BASE_URL, env.APP_BASE_URL].filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  return new Set([reachedOrigin(c), ...configured.map((u) => new URL(u).origin)]);
}

/** Whether `resource` (RFC 8707) names this core's MCP endpoint. */
function resourceIsOurs(c: Context, resource: string): boolean {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  const path = url.pathname.replace(/\/+$/, '');
  return servedOrigins(c).has(url.origin) && path === '/mcp' && !url.search && !url.hash;
}

const authorizeParams = {
  client_id: z.uuid(),
  redirect_uri: z.string().min(1).max(2000),
  response_type: z.literal('code'),
  code_challenge: z.string().regex(CODE_CHALLENGE),
  code_challenge_method: z.literal('S256'),
  scope: z.string().max(200).optional(),
  resource: z.string().max(2000).optional(),
  state: z.string().max(1000).optional(),
};
const authorizeQuery = z.object(authorizeParams);
const SHAPE =
  'client_id, redirect_uri, response_type=code, code_challenge (S256, 43 characters) and code_challenge_method=S256, with optional scope, resource and state';

type AuthorizeParams = z.infer<typeof authorizeQuery>;

/** Who is asking and what for, or the refusal the consent page shows in place of the question. */
async function readRequest(c: Context, params: AuthorizeParams) {
  const client = await findClient(params.client_id);
  if (!client) {
    throw refuse(
      'MCP_AUTH_CLIENT_UNKNOWN',
      `no MCP client is registered as ${params.client_id}; the client registers again and retries`,
      '/client_id',
    );
  }
  if (!redirectUriRegistered(params.redirect_uri, client.redirectUris)) {
    throw refuse(
      'MCP_AUTH_REDIRECT_UNREGISTERED',
      `${params.redirect_uri} is not a redirect URI ${client.clientName} registered`,
      '/redirect_uri',
    );
  }
  if (params.resource !== undefined && !resourceIsOurs(c, params.resource)) {
    throw refuse(
      'MCP_AUTH_RESOURCE_FOREIGN',
      `resource ${params.resource} is not this Forge's MCP endpoint (<origin>/mcp)`,
      '/resource',
    );
  }
  const asked = parseScope(params.scope);
  if ('unknown' in asked) {
    throw refuse(
      'MCP_AUTH_SCOPE_INVALID',
      `scope ${asked.unknown} is not offered; the scopes are ${MCP_OAUTH_SCOPES.join(' and ')}`,
      '/scope',
    );
  }
  return { client, requestedScopes: asked.scopes };
}

mcpOauthRoutes.get(
  '/authorize',
  requireAuth(),
  assertEmailVerified(),
  zValidator('query', authorizeQuery, invalid(SHAPE)),
  async (c) => {
    const params = c.req.valid('query');
    const { client, requestedScopes } = await readRequest(c, params);
    const view: McpConsentView = {
      client: {
        id: client.id,
        name: client.clientName,
        redirectHost: new URL(params.redirect_uri).host,
        registeredAt: client.createdAt.toISOString(),
      },
      requestedScopes,
      menu: patMenu(),
    };
    return c.json(view);
  },
);

const decisionBody = z
  .object({
    ...authorizeParams,
    decision: z.enum(['allow', 'deny']),
    project_ids: z.array(z.uuid()).min(1).max(50).nullable().optional(),
    permissions: z.array(z.string().min(1).max(100)).max(200).optional(),
    scopes: z.array(z.enum(MCP_OAUTH_SCOPES)).min(1).optional(),
  })
  .strict();

mcpOauthRoutes.post(
  '/authorize',
  requireAuth(),
  assertEmailVerified(),
  zValidator('json', decisionBody, invalid(`${SHAPE}, and decision (allow or deny)`)),
  async (c) => {
    const body = c.req.valid('json');
    const { client, requestedScopes } = await readRequest(c, body);
    const answer = (params: Record<string, string | undefined>): McpConsentAnswer => ({
      redirectTo: redirectWith(body.redirect_uri, {
        ...params,
        state: body.state,
        iss: reachedOrigin(c),
      }),
    });
    if (body.decision === 'deny') return c.json(answer({ error: 'access_denied' }));

    const userId = c.get('userId');
    await assertFreshAuth(userId);
    const projectIds = body.project_ids ?? null;
    const permissions = mintableGrant(body.permissions, projectIds !== null);
    const scopes: McpOAuthScope[] = body.scopes ?? requestedScopes;
    const beyond = scopes.find((s) => !requestedScopes.includes(s));
    if (beyond) {
      throw refuse(
        'MCP_AUTH_SCOPE_INVALID',
        `${client.clientName} asked for ${requestedScopes.join(' ')}; a grant holds no more, and ${beyond} is more`,
        '/scopes',
      );
    }
    await assertProjectsVisible(userId, projectIds ?? []);
    await endLapsedGrants(userId);
    await assertUnderTokenLimit(userId);

    const code = await issueCode({
      clientId: client.id,
      userId,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      resource: body.resource ?? null,
      scopes,
      projectIds,
      permissions: [...permissions],
      grantEpoch: PAT_GRANT_EPOCH,
    });
    return c.json(answer({ code }));
  },
);

// ── Token (RFC 6749 §4.1.3, §6) ─────────────────────────────────────────────

const tokenForm = z.looseObject({
  grant_type: z.string(),
  client_id: z.string().optional(),
  code: z.string().optional(),
  redirect_uri: z.string().optional(),
  code_verifier: z.string().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  resource: z.string().optional(),
});

function tokenAnswer(c: Context, outcome: TokenOutcome) {
  if ('error' in outcome) return oauthError(c, outcome.error, outcome.description);
  return c.json(
    {
      access_token: outcome.accessToken,
      token_type: 'Bearer',
      expires_in: MCP_OAUTH_ACCESS_TTL_SECONDS,
      refresh_token: outcome.refreshToken,
      scope: outcome.scopes.join(' '),
    },
    200,
    { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  );
}

mcpOauthRoutes.post(
  '/token',
  zValidator('form', tokenForm, (r, c) =>
    r.success
      ? undefined
      : oauthError(c, 'invalid_request', 'send grant_type and its parameters, form-encoded'),
  ),
  async (c) => {
    const form = c.req.valid('form');
    const clientId = form.client_id;
    if (!clientId || !z.uuid().safeParse(clientId).success || !(await findClient(clientId))) {
      return oauthError(c, 'invalid_client', 'client_id names no registered client', 401);
    }
    if (form.resource !== undefined && !resourceIsOurs(c, form.resource)) {
      return oauthError(c, 'invalid_target', `${form.resource} is not this Forge's MCP endpoint`);
    }
    if (form.grant_type === 'authorization_code') {
      if (!form.code || !form.redirect_uri || !form.code_verifier) {
        return oauthError(c, 'invalid_request', 'send code, redirect_uri and code_verifier');
      }
      return tokenAnswer(
        c,
        await redeemCode({
          code: form.code,
          clientId,
          redirectUri: form.redirect_uri,
          codeVerifier: form.code_verifier,
        }),
      );
    }
    if (form.grant_type === 'refresh_token') {
      if (!form.refresh_token) return oauthError(c, 'invalid_request', 'send refresh_token');
      const asked = form.scope === undefined ? null : parseScope(form.scope);
      if (asked && 'unknown' in asked) {
        return oauthError(c, 'invalid_scope', `scope ${asked.unknown} is not offered`);
      }
      return tokenAnswer(
        c,
        await refreshGrant({
          refreshToken: form.refresh_token,
          clientId,
          scopes: asked ? asked.scopes : null,
        }),
      );
    }
    return oauthError(
      c,
      'unsupported_grant_type',
      `grant_type ${form.grant_type} is not offered; send authorization_code or refresh_token`,
    );
  },
);
