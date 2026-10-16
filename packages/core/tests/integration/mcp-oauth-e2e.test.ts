/**
 * MCP OAuth: an MCP client signs in to `/mcp` through the browser. It finds the sign-in from the
 * 401, registers itself, the person consents with a reach, and the code it gets back is redeemed
 * for an hour-long access token and a refresh token that rotates. Every way a grant ends — a code
 * or a refresh token presented twice, the access token revoked on the tokens page, a newer consent
 * — is driven here and watched taking the token with it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { mcpOauthGrants, personalAccessTokens } from '../../src/db/schema.js';
import { app } from '../../src/index.js';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const ORIGIN = 'http://forge.test';
const REDIRECT = 'http://127.0.0.1:43123/callback';

let ownerId = '';
let first = '';
let second = '';
let session = '';

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  first = (await createTestProject(ownerId)).id;
  second = (await createTestProject(ownerId)).id;
  await addProjectMember(first, ownerId, 'owner');
  await addProjectMember(second, ownerId, 'owner');
  session = await userToken(ownerId);
  await db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${ownerId}`);
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function form(path: string, fields: Record<string, string>) {
  const res = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

const mcpList = (token: string | null) =>
  api(
    token,
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { accept: 'application/json, text/event-stream' },
  );

async function register(redirectUris = [REDIRECT]) {
  const res = await api(null, 'POST', '/api/mcp-auth/register', {
    client_name: 'Claude Code',
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.client_id as string;
}

function ask(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    ...extra,
  };
}

/** Consent as the signed-in person, answering the code from the redirect it returns. */
async function consent(
  clientId: string,
  challenge: string,
  reach: Record<string, unknown> = { project_ids: [first], permissions: ['*'] },
) {
  const res = await api(session, 'POST', '/api/mcp-auth/authorize', {
    ...ask(clientId, challenge),
    decision: 'allow',
    ...reach,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const to = new URL(res.body.redirectTo as string);
  expect(to.searchParams.get('state')).toBe('st-1');
  return to.searchParams.get('code') as string;
}

const redeem = (clientId: string, code: string, verifier: string) =>
  form('/api/mcp-auth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });

const refresh = (clientId: string, refreshToken: string) =>
  form('/api/mcp-auth/token', {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });

/** A client signed in end to end: its id and the token pair it holds. */
async function signedIn() {
  const clientId = await register();
  const { verifier, challenge } = pkce();
  const code = await consent(clientId, challenge);
  const res = await redeem(clientId, code, verifier);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { clientId, code, verifier, tokens: res.body };
}

const grantOf = async (clientId: string) =>
  db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId, clientId));

describe('an MCP client finds where to sign in', () => {
  it('reads resource_metadata off the 401 and follows it to the endpoints', async () => {
    const res = await mcpList(null);
    expect(res.status).toBe(401);
    const header = res.headers.get('www-authenticate') ?? '';
    expect(header).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    const resource = await api(null, 'GET', '/.well-known/oauth-protected-resource/mcp');
    expect(resource.status).toBe(200);
    expect(resource.body).toMatchObject({
      resource: `${ORIGIN}/mcp`,
      authorization_servers: [ORIGIN],
    });
    const server = await api(null, 'GET', '/.well-known/oauth-authorization-server');
    expect(server.status).toBe(200);
    expect(server.body).toMatchObject({
      issuer: ORIGIN,
      token_endpoint: `${ORIGIN}/api/mcp-auth/token`,
      registration_endpoint: `${ORIGIN}/api/mcp-auth/register`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(server.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
  });
});

describe('registering a client', () => {
  it('refuses a redirect URI that is neither https nor loopback, naming it', async () => {
    const res = await api(null, 'POST', '/api/mcp-auth/register', {
      redirect_uris: ['http://attacker.example/cb'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_redirect_uri');
    expect(res.body.error_description).toContain('attacker.example');
  });

  it('refuses a client that would authenticate with a secret', async () => {
    const res = await api(null, 'POST', '/api/mcp-auth/register', {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });
});

describe('the consent page', () => {
  it('shows who asks and where the answer goes', async () => {
    const clientId = await register();
    const q = new URLSearchParams(ask(clientId, pkce().challenge, { scope: 'read' }));
    const res = await api(session, 'GET', `/api/mcp-auth/authorize?${q}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      client: { id: clientId, name: 'Claude Code', redirectHost: '127.0.0.1:43123' },
      requestedScopes: ['read'],
    });
  });

  it('refuses an unknown client and an unregistered redirect URI by name', async () => {
    const clientId = await register();
    const unknown = new URLSearchParams(ask(crypto.randomUUID(), pkce().challenge));
    const a = await api(session, 'GET', `/api/mcp-auth/authorize?${unknown}`);
    expect(a.status).toBe(404);
    expect(a.body.code).toBe('MCP_AUTH_CLIENT_UNKNOWN');

    const elsewhere = new URLSearchParams(
      ask(clientId, pkce().challenge, { redirect_uri: 'https://attacker.example/cb' }),
    );
    const b = await api(session, 'GET', `/api/mcp-auth/authorize?${elsewhere}`);
    expect(b.status).toBe(422);
    expect(b.body.code).toBe('MCP_AUTH_REDIRECT_UNREGISTERED');
  });

  it('matches a loopback redirect URI whatever its port', async () => {
    const clientId = await register();
    const q = new URLSearchParams(
      ask(clientId, pkce().challenge, { redirect_uri: 'http://127.0.0.1:50999/callback' }),
    );
    const res = await api(session, 'GET', `/api/mcp-auth/authorize?${q}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses consent given by a token rather than a person', async () => {
    const clientId = await register();
    const pat = await patToken(ownerId, [first]);
    const q = new URLSearchParams(ask(clientId, pkce().challenge));
    const res = await api(pat, 'GET', `/api/mcp-auth/authorize?${q}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("an MCP client's browser sign-in");
  });

  it('refuses a resource other than this Forge’s /mcp', async () => {
    const clientId = await register();
    const q = new URLSearchParams(
      ask(clientId, pkce().challenge, { resource: 'https://other.example/mcp' }),
    );
    const res = await api(session, 'GET', `/api/mcp-auth/authorize?${q}`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MCP_AUTH_RESOURCE_FOREIGN');
  });

  it('answers a denial with access_denied and the state, minting nothing', async () => {
    const clientId = await register();
    const res = await api(session, 'POST', '/api/mcp-auth/authorize', {
      ...ask(clientId, pkce().challenge),
      decision: 'deny',
    });
    expect(res.status).toBe(200);
    const to = new URL(res.body.redirectTo as string);
    expect(to.origin + to.pathname).toBe(REDIRECT);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('st-1');
    expect(to.searchParams.get('code')).toBeNull();
  });

  it('asks for a fresh sign-in before it allows', async () => {
    await db.execute(sql`UPDATE users SET last_fresh_auth_at = NULL WHERE id = ${ownerId}`);
    const clientId = await register();
    const res = await api(session, 'POST', '/api/mcp-auth/authorize', {
      ...ask(clientId, pkce().challenge),
      decision: 'allow',
      project_ids: [first],
      permissions: ['*'],
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FRESH_AUTH_REQUIRED');
  });

  it('refuses a grant wider than the client asked for', async () => {
    const clientId = await register();
    const res = await api(session, 'POST', '/api/mcp-auth/authorize', {
      ...ask(clientId, pkce().challenge, { scope: 'read' }),
      decision: 'allow',
      project_ids: [first],
      permissions: ['*'],
      scopes: ['read', 'write'],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MCP_AUTH_SCOPE_INVALID');
  });

  it('holds a grant to the token form’s rules: a stated reach on projects the person sees', async () => {
    const clientId = await register();
    const unstated = await api(session, 'POST', '/api/mcp-auth/authorize', {
      ...ask(clientId, pkce().challenge),
      decision: 'allow',
      project_ids: [first],
    });
    expect(unstated.status).toBe(400);
    expect(unstated.body.code).toBe('PAT_PERMISSIONS_REQUIRED');

    const strangerId = (await createTestUser({ verified: true })).id;
    const foreign = (await createTestProject(strangerId)).id;
    const unseen = await api(session, 'POST', '/api/mcp-auth/authorize', {
      ...ask(clientId, pkce().challenge),
      decision: 'allow',
      project_ids: [foreign],
      permissions: ['*'],
    });
    expect(unseen.status).toBe(403);
    expect(unseen.body.code).toBe('FORBIDDEN_PROJECT');
  });
});

describe('redeeming a code', () => {
  it('answers a token pair whose access token reaches /mcp, fenced as consented, for an hour', async () => {
    const { tokens } = await signedIn();
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
    expect(tokens.refresh_token).toMatch(/^forge_mcp_rt_/);

    const listed = await mcpList(tokens.access_token as string);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);

    const [row] = await db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, ownerId));
    expect(row?.name).toMatch(/^mcp oauth /);
    expect(row?.projectIds).toEqual([first]);
    const lives = (row?.expiresAt?.getTime() ?? 0) - Date.now();
    expect(lives).toBeGreaterThan(59 * 60_000);
    expect(lives).toBeLessThanOrEqual(60 * 60_000);
  });

  it('refuses a verifier that does not answer the challenge', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const code = await consent(clientId, challenge);
    const res = await redeem(clientId, code, pkce().verifier);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error_description).toContain('code_verifier');
  });

  it('ends the grant when its code is redeemed a second time', async () => {
    const { clientId, code, verifier, tokens } = await signedIn();
    const again = await redeem(clientId, code, verifier);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
    expect((await mcpList(tokens.access_token as string)).status).toBe(401);
    expect((await refresh(clientId, tokens.refresh_token as string)).body.error).toBe(
      'invalid_grant',
    );
  });

  it('refuses a code redeemed by another client', async () => {
    const clientId = await register();
    const other = await register();
    const { verifier, challenge } = pkce();
    const code = await consent(clientId, challenge);
    const res = await redeem(other, code, verifier);
    expect(res.body.error).toBe('invalid_grant');
  });
});

describe('refreshing', () => {
  it('rotates both tokens, and the old access token stops answering', async () => {
    const { clientId, tokens } = await signedIn();
    const next = await refresh(clientId, tokens.refresh_token as string);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.refresh_token).not.toBe(tokens.refresh_token);
    expect((await mcpList(tokens.access_token as string)).status).toBe(401);
    expect((await mcpList(next.body.access_token as string)).status).toBe(200);
  });

  it('ends the grant when a spent refresh token is presented again', async () => {
    const { clientId, tokens } = await signedIn();
    const next = await refresh(clientId, tokens.refresh_token as string);
    const replay = await refresh(clientId, tokens.refresh_token as string);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await mcpList(next.body.access_token as string)).status).toBe(401);
    expect((await refresh(clientId, next.body.refresh_token as string)).body.error).toBe(
      'invalid_grant',
    );
    const [grant] = await grantOf(clientId);
    expect(grant?.revokedReason).toContain('spent refresh token');
  });

  it('ends the grant once its access token is revoked on the tokens page', async () => {
    const { clientId, tokens } = await signedIn();
    const [grant] = await grantOf(clientId);
    const revoked = await api(session, 'DELETE', `/api/pat/${grant?.currentTokenId}`);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const res = await refresh(clientId, tokens.refresh_token as string);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error_description).toContain('tokens page');
    const [ended] = await grantOf(clientId);
    expect(ended?.revokedAt).not.toBeNull();
  });

  it('refuses a refresh token past its month', async () => {
    const { clientId, tokens } = await signedIn();
    await db
      .update(mcpOauthGrants)
      .set({ refreshExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpOauthGrants.clientId, clientId));
    const res = await refresh(clientId, tokens.refresh_token as string);
    expect(res.body.error).toBe('invalid_grant');
    expect(res.body.error_description).toContain('expired');
  });

  it('refuses a scope the grant does not hold', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const res = await api(session, 'POST', '/api/mcp-auth/authorize', {
      ...ask(clientId, challenge, { scope: 'read' }),
      decision: 'allow',
      project_ids: [first],
      permissions: ['*'],
    });
    const code = new URL(res.body.redirectTo as string).searchParams.get('code') as string;
    const pair = await redeem(clientId, code, verifier);
    expect(pair.body.scope).toBe('read');
    const wider = await form('/api/mcp-auth/token', {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: pair.body.refresh_token as string,
      scope: 'read write',
    });
    expect(wider.body.error).toBe('invalid_scope');
  });
});

describe('a newer consent for the same client', () => {
  it('replaces the earlier grant and its token', async () => {
    const { clientId, tokens } = await signedIn();
    const { verifier, challenge } = pkce();
    const code = await consent(clientId, challenge, { project_ids: [second], permissions: ['*'] });
    const fresh = await redeem(clientId, code, verifier);
    expect(fresh.status).toBe(200);
    expect((await mcpList(tokens.access_token as string)).status).toBe(401);
    expect((await refresh(clientId, tokens.refresh_token as string)).body.error).toBe(
      'invalid_grant',
    );
    const live = (await grantOf(clientId)).filter((g) => g.revokedAt === null);
    expect(live.map((g) => g.projectIds)).toEqual([[second]]);
  });
});

describe('the reserved token name', () => {
  it('refuses a personal token named like an MCP sign-in', async () => {
    const res = await api(session, 'POST', '/api/pat', {
      name: 'mcp oauth 1234',
      permissions: ['*'],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PAT_NAME_RESERVED');
  });
});
