// @direct-test-of packages/core/src/credentials/mcp-oauth-routes.ts
// @direct-test-of packages/core/src/credentials/mcp-oauth-store.ts
// @direct-test-of packages/core/src/credentials/mcp-oauth-metadata.ts
// @direct-test-of packages/core/src/db/schema-mcp-oauth.ts
/**
 * MCP OAuth's issuer (RFC 9207): the redirect answering a consent carries `iss`, which a client
 * compares with the issuer it discovered. Where the API and the web are different hosts the
 * consent is posted through the web's, so `iss` is the issuer the client registered at, recorded
 * on the client, and a client with none recorded is refused until it registers again (ISS-913).
 * The rest of the flow is `mcp-oauth-e2e.test.ts`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { mcpOauthClients, mcpOauthGrants } from '../../src/db/schema.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  truncateAll,
} from '../helpers/factories.js';

const REDIRECT = 'http://127.0.0.1:43123/callback';

let first = '';
let session = '';

beforeEach(async () => {
  await truncateAll();
  const ownerId = (await createTestUser({ verified: true })).id;
  first = (await createTestProject(ownerId)).id;
  await addProjectMember(first, ownerId, 'owner');
  session = await userToken(ownerId);
  await db.execute(sql`UPDATE users SET last_fresh_auth_at = now() WHERE id = ${ownerId}`);
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** The proxy headers of a request that reached core at `origin`, as the one in front of it sends. */
const reaching = (origin: string) => {
  const url = new URL(origin);
  return { 'x-forwarded-proto': url.protocol.slice(0, -1), 'x-forwarded-host': url.host };
};

async function register(redirectUris = [REDIRECT], headers: Record<string, string> = {}) {
  const res = await api(
    null,
    'POST',
    '/api/mcp-auth/register',
    { client_name: 'Claude Code', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' },
    headers,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.client_id as string;
}

function ask(clientId: string, challenge: string) {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
  };
}

const grantOf = async (clientId: string) =>
  db.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.clientId, clientId));

describe('the issuer a consent names (RFC 9207)', () => {
  // forge-dev's shape: the API and the web are different hosts, and the SPA posts the consent
  // through the web's
  const API = 'https://forge-api.test';
  const WEB = 'https://forge-web.test';

  it('is the issuer the client discovered and registered at, not the origin the consent reached', async () => {
    const server = await api(null, 'GET', '/.well-known/oauth-authorization-server', undefined, {
      ...reaching(API),
    });
    expect(server.body.issuer).toBe(API);
    expect(server.body.registration_endpoint).toBe(`${API}/api/mcp-auth/register`);

    const clientId = await register([REDIRECT], reaching(API));
    const asked = { ...ask(clientId, pkce().challenge), project_ids: [first], permissions: ['*'] };
    const allowed = await api(
      session,
      'POST',
      '/api/mcp-auth/authorize',
      { ...asked, decision: 'allow' },
      reaching(WEB),
    );
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const to = new URL(allowed.body.redirectTo as string);
    expect(to.searchParams.get('code')).toBeTruthy();
    expect(to.searchParams.get('iss')).toBe(server.body.issuer);

    const denied = await api(
      session,
      'POST',
      '/api/mcp-auth/authorize',
      { ...ask(clientId, pkce().challenge), decision: 'deny' },
      reaching(WEB),
    );
    expect(denied.status, JSON.stringify(denied.body)).toBe(200);
    const deniedTo = new URL(denied.body.redirectTo as string);
    expect(deniedTo.searchParams.get('error')).toBe('access_denied');
    expect(deniedTo.searchParams.get('iss')).toBe(API);
  });

  it('refuses a client registered before its issuer was recorded, telling it to register again', async () => {
    const clientId = await register();
    await db.update(mcpOauthClients).set({ issuer: null }).where(eq(mcpOauthClients.id, clientId));

    const q = new URLSearchParams(ask(clientId, pkce().challenge));
    const shown = await api(session, 'GET', `/api/mcp-auth/authorize?${q}`);
    expect(shown.status).toBe(409);
    expect(shown.body.code).toBe('MCP_AUTH_CLIENT_ISSUER_UNRECORDED');

    for (const decision of ['allow', 'deny']) {
      const res = await api(session, 'POST', '/api/mcp-auth/authorize', {
        ...ask(clientId, pkce().challenge),
        decision,
        project_ids: [first],
        permissions: ['*'],
      });
      expect(res.status, decision).toBe(409);
      expect(res.body.code).toBe('MCP_AUTH_CLIENT_ISSUER_UNRECORDED');
      expect(JSON.stringify(res.body)).toContain('registers again');
    }
    expect(await grantOf(clientId)).toHaveLength(0);
  });
});
