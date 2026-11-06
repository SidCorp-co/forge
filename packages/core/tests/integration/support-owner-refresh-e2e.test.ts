import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token, the product API's key and the owner's tokens are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { readOwnerCredential } from '../../src/support/owner-credential.js';
import { roomsOfProject } from '../../src/support/store.js';
import { roomSecrets } from '../../src/support/thread.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { CLIENT_ID, OauthProduct } from '../helpers/oauth-product.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { type Act, code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-refresh.ts
// @direct-test-of packages/core/src/integrations/support-api/owner-oauth.ts
// @direct-test-of packages/core/src/support/owner-sign-in.ts
// @direct-test-of packages/core/src/support/owner-credential.ts
// @direct-test-of packages/core/src/support/owner-routes.ts
// @direct-test-of packages/core/src/support/owner-act.ts
//
// ISS-1047 (REQ-85 BC-2, BC-3, BC-4): Agenfold's owner acts take only a person's OAuth access token,
// which lives an hour, beside a single-use refresh token that rotates. Core starts the owner's
// sign-in, keeps the tokens his confirmation gives, refreshes the access token itself before an
// act, never spends one refresh token twice, ends the credential by name when the product refuses a
// refresh, and hands the session neither token.

const w = new AgentWorld();
let chat: StandInRocketChat;
const product = new OauthProduct();
let agenfold = '';
/** Everything the session was handed, each answer pushed as it came. */
const answers: unknown[] = [];

const credentialsPath = () => `/api/projects/${w.projectId}/support/owner-credentials`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The session runs `does` in a new thread the owner opens in his room; what it got back is kept. */
async function inOwnerRoom<T extends Record<string, unknown> | Record<string, unknown>[]>(
  text: string,
  does: (act: Act, thread: string) => Promise<T>,
): Promise<T> {
  let out: T | undefined;
  await w.hear(
    () => chat.say(chat.alice, text),
    async (_t, act, message) => {
      out = await does(act, message().thread);
    },
  );
  answers.push(out);
  return out as T;
}

const createOrganization = (act: Act, thread: string, name: string) =>
  act({ action: 'owner_act', thread, tool: 'create_organization', args: { name } });

/** Keep a pair the product minted, as an admin would at the door, with `expiresIn` seconds left. */
async function keepPair(pair: { accessToken: string; refreshToken: string }, expiresIn: number) {
  const kept = await api(w.owner, 'PUT', `${credentialsPath()}/${agenfold}`, {
    oauth: { ...pair, expiresIn },
  });
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  answers.push(kept.body);
}

const stored = async () => {
  const read = await readOwnerCredential(w.projectId, agenfold);
  if (!read.ok) throw new Error(`no owner credential readable: ${read.why}`);
  return read.value;
};

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  await product.start(3600);
  const bound = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'support-api',
    displayName: 'Agenfold',
    config: { baseUrl: `${product.base}/api` },
    secrets: { headers: { 'X-Api-Key': 'agf_scoped_read_key_9876543210' } },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: {
          provider: 'support-api',
          label: 'agenfold',
          tools: [
            {
              name: 'create_organization',
              kind: 'owner',
              method: 'POST',
              path: '/organizations',
              summary: 'create an organization, as the owner',
              params: {
                name: { in: 'body', description: 'the organization name', required: true },
              },
            },
          ],
          ownerSignIn: {
            authorizationUrl: `${product.base}/oauth/authorize`,
            tokenUrl: `${product.base}/oauth/token`,
            clientId: CLIENT_ID,
            scopes: ['organizations:write', 'offline_access'],
          },
        },
      },
    ],
  });
  expect(bound.status, JSON.stringify(bound.body)).toBe(201);
  const [b] = await rows<{ id: string }>(sql`
    SELECT id FROM integration_bindings
     WHERE project_id = ${w.projectId}::uuid AND provider = 'support-api' AND label = 'agenfold'`);
  agenfold = String(b?.id);
  await w.settleWarm();
}, 120_000);

afterAll(async () => {
  await product.close();
  await w.stop();
});

describe('ISS-1047: core starts the owner sign-in, and his confirmation is his consent (BC-3)', () => {
  let callback: URL;

  it('hands the session the product authorization link, PKCE S256, for the owner to open', async () => {
    const out = await inOwnerRoom('cho tôi đăng nhập Agenfold để bạn làm thay tôi', (act, thread) =>
      act({ action: 'owner_sign_in', thread, product: 'agenfold' }),
    );
    expect(out, JSON.stringify(out)).toMatchObject({ isError: false, product: 'agenfold' });
    const link = new URL(String(out.url));
    expect(link.origin + link.pathname).toBe(`${product.base}/oauth/authorize`);
    expect(Object.fromEntries(link.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENT_ID,
      code_challenge_method: 'S256',
      scope: 'organizations:write offline_access',
      redirect_uri: expect.stringMatching(/\/api\/support\/owner-sign-in\/callback$/),
    });
    // nothing is kept yet, and no consent stands before he confirms
    expect((await api(w.owner, 'GET', credentialsPath())).body.credentials).toContainEqual(
      expect.objectContaining({ bindingId: agenfold, kept: false }),
    );
    callback = await product.confirm(link.href);
  });

  it('keeps the tokens his confirmation gives, sealed, and records his consent naming the route', async () => {
    const landed = await api(null, 'GET', `${callback.pathname}${callback.search}`);
    expect(landed.status, JSON.stringify(landed.body)).toBe(200);
    expect(String(landed.body.text)).toContain('Signed in to agenfold');
    answers.push(landed.body);
    // the code was traded with the verifier only core held, at the redirect it was issued for
    expect(product.codeTrades).toEqual([
      { verifierOk: true, redirect: expect.stringMatching(/callback$/) },
    ]);
    const kept = await stored();
    expect('oauth' in kept && kept.oauth.refreshToken).toBe(product.issued.at(-1));
    const [sealed] = await rows<{ value: string }>(sql`
      SELECT encode(value_enc, 'escape') AS value FROM project_secrets
       WHERE project_id = ${w.projectId}::uuid AND scope = 'owner-acts'`);
    for (const t of product.issued) expect(sealed?.value).not.toContain(t);
    const consents = await rows<{
      route: string;
      owner_key: string;
      given_message: string | null;
      withdrawn: boolean;
    }>(sql`
      SELECT route, owner_key, given_message, withdrawn_at IS NOT NULL AS withdrawn
        FROM support_owner_consents WHERE project_id = ${w.projectId}::uuid AND binding_id = ${agenfold}::uuid`);
    expect(consents).toEqual([
      { route: 'sign_in', owner_key: OWNER_ID, given_message: null, withdrawn: false },
    ]);
    const facts = await rows<{
      kind: string;
      actor_key: string;
      input: Record<string, unknown>;
    }>(sql`
      SELECT kind, actor_key, input FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND kind IN ('owner_signed_in', 'owner_consented')
       ORDER BY kind`);
    // one transaction writes both, so they share a time: read in the order of their kind
    expect(facts).toEqual([
      {
        kind: 'owner_consented',
        actor_key: OWNER_ID,
        input: expect.objectContaining({ route: 'sign_in', product: 'agenfold', citedBy: 'core' }),
      },
      {
        kind: 'owner_signed_in',
        actor_key: OWNER_ID,
        input: expect.objectContaining({ route: 'sign_in', product: 'agenfold' }),
      },
    ]);
  });

  it('spends a sign-in once: the same return again keeps nothing more', async () => {
    const again = await api(null, 'GET', `${callback.pathname}${callback.search}`);
    expect(again.status).toBe(409);
    expect(String(again.body.text)).toContain('already used');
    expect(product.codeTrades).toHaveLength(1);
  });

  it('lets the room act as him at once with what he signed in with', async () => {
    const out = await inOwnerRoom('tạo tổ chức SidCorp', (act, thread) =>
      createOrganization(act, thread, 'SidCorp'),
    );
    expect(out, JSON.stringify(out)).toMatchObject({
      isError: false,
      status: 201,
      asOwner: OWNER_ID,
    });
    const kept = await stored();
    expect(product.calls.at(-1)?.auth).toBe(
      `Bearer ${'oauth' in kept ? kept.oauth.accessToken : ''}`,
    );
    expect(product.refreshes).toEqual([]);
  });

  it('refuses a sign-in for a product whose binding declares none, naming what to declare', async () => {
    const out = await inOwnerRoom('and sign me in to the catalog', (act, thread) =>
      act({ action: 'owner_sign_in', thread, product: 'Catalog API' }),
    );
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_SIGN_IN_UNDECLARED');
    expect(JSON.stringify(out)).toContain('ownerSignIn { authorizationUrl, tokenUrl, clientId');
  });
});

describe('ISS-1047: core refreshes the access token before an act (BC-2)', () => {
  it('acts after expiry through a refresh, and the rotated refresh token is the one stored', async () => {
    const pair = product.mint(1);
    await keepPair(pair, 1);
    await sleep(1_200);
    const before = product.calls.length;
    const out = await inOwnerRoom('tạo thêm tổ chức Moc', (act, thread) =>
      createOrganization(act, thread, 'Moc'),
    );
    expect(out, JSON.stringify(out)).toMatchObject({ isError: false, status: 201 });
    expect(product.refreshes).toEqual([{ refreshToken: pair.refreshToken, answered: 200 }]);
    expect(product.refreshState(pair.refreshToken)).toBe('spent');
    const kept = await stored();
    if (!('oauth' in kept)) throw new Error(`stored ${Object.keys(kept)}`);
    // the pair the product rotated to is the one kept, and the act went out with its access token
    expect(kept.oauth.refreshToken).toBe(product.issued.at(-1));
    expect(kept.oauth.refreshToken).not.toBe(pair.refreshToken);
    expect(product.calls.slice(before)).toEqual([
      expect.objectContaining({
        url: '/api/organizations',
        auth: `Bearer ${kept.oauth.accessToken}`,
      }),
    ]);
    // the expired token was never sent
    expect(product.calls.map((c) => c.auth)).not.toContain(`Bearer ${pair.accessToken}`);
    // every line the room posts is scrubbed of both tokens kept now (thread.ts:roomSecrets)
    const [room] = await roomsOfProject(w.projectId);
    if (!room) throw new Error('no support room');
    expect(await roomSecrets(room)).toEqual(
      expect.arrayContaining([kept.oauth.accessToken, kept.oauth.refreshToken]),
    );
  });

  it('spends one refresh token once when two acts need it at the same moment', async () => {
    const pair = product.mint(1);
    await keepPair(pair, 1);
    await sleep(1_200);
    product.refreshDelayMs = 400;
    const refreshed = product.refreshes.length;
    const outs = await inOwnerRoom('tạo hai tổ chức cùng lúc', (act, thread) =>
      Promise.all([
        createOrganization(act, thread, 'First'),
        createOrganization(act, thread, 'Second'),
      ]),
    );
    product.refreshDelayMs = 0;
    for (const out of outs)
      expect(out, JSON.stringify(outs)).toMatchObject({ isError: false, status: 201 });
    expect(product.refreshes.slice(refreshed)).toEqual([
      { refreshToken: pair.refreshToken, answered: 200 },
    ]);
  });
});

describe('ISS-1047: a refresh the product refuses ends the credential by name (BC-2, BC-7)', () => {
  it('refuses the act naming who signs in again and where, and sends nothing to the product', async () => {
    const pair = product.mint(1);
    await keepPair(pair, 1);
    product.revoke(pair.refreshToken);
    await sleep(1_200);
    const calls = product.calls.length;
    const out = await inOwnerRoom('tạo tổ chức Revoked', (act, thread) =>
      createOrganization(act, thread, 'Revoked'),
    );
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_SIGN_IN_AGAIN');
    const says = JSON.stringify(out);
    expect(says).toContain('agenfold refused its refresh: invalid_grant');
    expect(says).toContain(
      `only @alice, the owner this binding names, signs in, from his own room ${chat.rid}`,
    );
    expect(says).toContain('owner_sign_in');
    expect(product.calls.length).toBe(calls);
    expect(product.refreshes.at(-1)).toEqual({ refreshToken: pair.refreshToken, answered: 400 });
    // ended: no token is kept, and the list says so by name
    expect(await stored()).toEqual({
      ended: { at: expect.any(String), reason: expect.stringContaining('refused its refresh') },
    });
    const listed = await api(w.owner, 'GET', credentialsPath());
    expect(listed.body.credentials).toContainEqual(
      expect.objectContaining({
        bindingId: agenfold,
        kept: false,
        ended: expect.objectContaining({ reason: expect.any(String) }),
      }),
    );
  });

  it('refuses the next act too, without asking the product again', async () => {
    const refreshed = product.refreshes.length;
    const calls = product.calls.length;
    const out = await inOwnerRoom('thử lại', (act, thread) =>
      createOrganization(act, thread, 'Again'),
    );
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_SIGN_IN_AGAIN');
    expect(product.refreshes.length).toBe(refreshed);
    expect(product.calls.length).toBe(calls);
  });

  it('keeps no refresh token for a product whose binding could never spend it', async () => {
    const [catalog] = await rows<{ id: string }>(sql`
      SELECT b.id FROM integration_bindings b JOIN integration_connections c ON c.id = b.connection_id
       WHERE b.project_id = ${w.projectId}::uuid AND c.display_name = 'Catalog API'`);
    const refused = await api(w.owner, 'PUT', `${credentialsPath()}/${String(catalog?.id)}`, {
      oauth: { accessToken: 'cat_at_0123456789', refreshToken: 'cat_rt_0123456789' },
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('SUPPORT_OWNER_SIGN_IN_UNDECLARED');
  });

  it('keeps one credential of one kind: headers and oauth together, or neither, are refused', async () => {
    const path = `${credentialsPath()}/${agenfold}`;
    for (const body of [
      {
        headers: { 'X-Api-Key': 'agf_both_0123456789' },
        oauth: { accessToken: 'agf_both_at_0123' },
      },
      {},
    ]) {
      const refused = await api(w.owner, 'PUT', path, body);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(JSON.stringify(refused.body)).toContain('exactly one of headers');
    }
    // the ended credential stood through both
    expect(await stored()).toHaveProperty('ended');
  });
});

describe('ISS-1047: neither token reaches the session (BC-4)', () => {
  it('holds no access or refresh token in anything the session, its box or the room received', async () => {
    const bound = JSON.stringify([w.box.turns, w.box.acts, answers]);
    expect(product.issued.length).toBeGreaterThanOrEqual(8);
    expect(bound.length).toBeGreaterThan(1000);
    for (const t of product.issued) expect(bound).not.toContain(t);
    const lines = JSON.stringify(await w.chat.botLines());
    for (const t of product.issued) expect(lines).not.toContain(t);
    const logged = JSON.stringify(
      await rows(
        sql`SELECT input, output FROM support_actions WHERE project_id = ${w.projectId}::uuid`,
      ),
    );
    for (const t of product.issued) expect(logged).not.toContain(t);
  });
});
