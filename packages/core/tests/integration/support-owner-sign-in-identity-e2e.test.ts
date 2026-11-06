import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token, the product API's key and the owner's tokens are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

import { readOwnerCredential } from '../../src/support/owner-credential.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import {
  CLIENT_ID,
  OauthProduct,
  OTHER_ACCOUNT,
  OWNER_ACCOUNT,
  type ProductAccount,
} from '../helpers/oauth-product.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/owner-sign-in.ts
// @direct-test-of packages/core/src/support/owner-identity.ts
// @direct-test-of packages/core/src/integrations/support-api/owner-oauth.ts
// @direct-test-of packages/core/src/support/owner-routes.ts
//
// ISS-1052 (REQ-85 BC-1, BC-3): the link core hands the owner is only a link, and whoever opens it
// can sign in at the product. Core reads who signed in (the id_token's claims, or the product's
// userinfo endpoint) and keeps the tokens and records his consent only when that is the owner's own
// account, the one his binding names. Anybody else's sign-in keeps nothing and records nothing, and
// a binding naming no owner account, or no way to read one, starts no sign-in.

const w = new AgentWorld();
let chat: StandInRocketChat;
const product = new OauthProduct();
/** Each product's binding id, by the name the room knows it by. */
const bindings: Record<string, string> = {};

/** The one owner act each product grants, under a name of its own: a tool name calls one API. */
const createOrganization = (label: string) => ({
  name: `create_organization_${label.replace(/-/g, '_')}`,
  kind: 'owner',
  method: 'POST',
  path: '/organizations',
  summary: 'create an organization, as the owner',
  params: { name: { in: 'body', description: 'the organization name', required: true } },
});

/** Bind one more product, all of them the stand-in, each declaring its sign-in as `signIn` adds. */
async function bind(label: string, signIn: Record<string, unknown>) {
  const bound = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'support-api',
    displayName: `Agenfold ${label}`,
    config: { baseUrl: `${product.base}/api` },
    secrets: { headers: { 'X-Api-Key': `agf_scoped_read_key_${label}_0123` } },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: {
          provider: 'support-api',
          label,
          tools: [createOrganization(label)],
          ownerSignIn: {
            authorizationUrl: `${product.base}/oauth/authorize`,
            tokenUrl: `${product.base}/oauth/token`,
            clientId: CLIENT_ID,
            ...signIn,
          },
        },
      },
    ],
  });
  expect(bound.status, JSON.stringify(bound.body)).toBe(201);
  const [b] = await rows<{ id: string }>(sql`
    SELECT id FROM integration_bindings
     WHERE project_id = ${w.projectId}::uuid AND provider = 'support-api' AND label = ${label}`);
  bindings[label] = String(b?.id);
}

/** The session asks for the owner's sign-in to `productName` in his room; what it was handed. */
async function startSignIn(productName: string): Promise<Record<string, unknown>> {
  let out: Record<string, unknown> = {};
  await w.hear(
    () => chat.say(chat.alice, `cho tôi đăng nhập ${productName}`),
    async (_t, act, message) => {
      out = await act({ action: 'owner_sign_in', thread: message().thread, product: productName });
    },
  );
  return out;
}

/** The link is opened and the sign-in completed at the product by `as`; where the browser lands. */
async function completeAs(productName: string, as: ProductAccount) {
  const started = await startSignIn(productName);
  expect(started, JSON.stringify(started)).toMatchObject({ isError: false });
  const back = await product.confirm(String(started.url), as);
  return api(null, 'GET', `${back.pathname}${back.search}`);
}

const consentsOf = (label: string) =>
  rows<{ route: string; owner_key: string }>(sql`
    SELECT route, owner_key FROM support_owner_consents
     WHERE project_id = ${w.projectId}::uuid AND binding_id = ${bindings[label]}::uuid`);

const factsOf = (label: string) =>
  rows<{ kind: string; output: Record<string, unknown> }>(sql`
    SELECT kind, output FROM support_actions
     WHERE project_id = ${w.projectId}::uuid AND input->>'product' = ${label}
       AND kind IN ('owner_signed_in', 'owner_consented', 'refused')
     ORDER BY created_at`);

const keptFor = async (label: string) =>
  (await readOwnerCredential(w.projectId, String(bindings[label]))).ok;

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  await product.start(3600);
  // reads who signed in from the id_token, and names the owner by his email, in another case
  await bind('agenfold', {
    scopes: ['openid', 'organizations:write'],
    owner: { claim: 'email', value: OWNER_ACCOUNT.email.toLowerCase() },
  });
  // asks for no id_token, and reads who signed in at the userinfo endpoint, naming the owner by sub
  await bind('agenfold-desk', {
    scopes: ['organizations:write'],
    userinfoUrl: `${product.base}/oauth/userinfo`,
    owner: { claim: 'sub', value: OWNER_ACCOUNT.sub },
  });
  // declares a sign-in and names no owner account
  await bind('agenfold-open', { scopes: ['openid'] });
  // names the owner, but neither asks for an id_token nor declares a userinfo endpoint
  await bind('agenfold-blind', {
    scopes: ['organizations:write'],
    owner: { claim: 'sub', value: OWNER_ACCOUNT.sub },
  });
  await w.settleWarm();
}, 120_000);

afterAll(async () => {
  await product.close();
  await w.stop();
});

describe('ISS-1052: a sign-in completed by another account keeps nothing (BC-1, BC-3)', () => {
  it('refuses the id_token sign-in of a second account by name, and keeps no credential and no consent', async () => {
    const landed = await completeAs('agenfold', OTHER_ACCOUNT);
    expect(landed.status, JSON.stringify(landed.body)).toBe(403);
    const page = String(landed.body.text);
    expect(page).toContain('Not signed in');
    expect(page).toContain(OTHER_ACCOUNT.email);
    expect(page).toContain('Nothing was kept');
    expect(await keptFor('agenfold')).toBe(false);
    expect(await consentsOf('agenfold')).toEqual([]);
    const facts = await factsOf('agenfold');
    expect(facts.map((f) => f.kind)).toEqual(['refused']);
    expect(facts[0]?.output).toMatchObject({ code: 'SUPPORT_OWNER_SIGN_IN_NOT_THE_OWNER' });
    // the room's record names the account that signed in and the one the binding expects
    expect(String(facts[0]?.output.detail)).toContain(OTHER_ACCOUNT.email);
    expect(String(facts[0]?.output.detail)).toContain(OWNER_ACCOUNT.email.toLowerCase());
    const [signIn] = await rows<{ outcome: string }>(sql`
      SELECT outcome FROM support_owner_sign_ins WHERE binding_id = ${bindings.agenfold}::uuid`);
    expect(signIn?.outcome).toContain('not the owner');
  });

  it('refuses the userinfo sign-in of a second account the same way', async () => {
    const asked = product.userinfoAsks.length;
    const landed = await completeAs('agenfold-desk', OTHER_ACCOUNT);
    expect(landed.status, JSON.stringify(landed.body)).toBe(403);
    expect(String(landed.body.text)).toContain(OTHER_ACCOUNT.sub);
    expect(product.userinfoAsks.length).toBe(asked + 1);
    expect(await keptFor('agenfold-desk')).toBe(false);
    expect(await consentsOf('agenfold-desk')).toEqual([]);
    expect((await factsOf('agenfold-desk')).map((f) => f.output.code)).toEqual([
      'SUPPORT_OWNER_SIGN_IN_NOT_THE_OWNER',
    ]);
  });

  it('keeps the owner own sign-in and records his consent, by id_token and by userinfo', async () => {
    for (const label of ['agenfold', 'agenfold-desk']) {
      const landed = await completeAs(label, OWNER_ACCOUNT);
      expect(landed.status, `${label}: ${JSON.stringify(landed.body)}`).toBe(200);
      expect(await keptFor(label)).toBe(true);
      expect(await consentsOf(label)).toEqual([{ route: 'sign_in', owner_key: OWNER_ID }]);
    }
  });
});

describe('ISS-1052: a binding naming no owner account starts no sign-in', () => {
  it('refuses a binding with no owner by name, saying what to declare', async () => {
    const out = await startSignIn('agenfold-open');
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_IDENTITY_UNDECLARED');
    expect(JSON.stringify(out)).toContain("ownerSignIn.owner { claim: 'sub' | 'email', value }");
  });

  it('refuses a binding that names the owner but no way to read who signed in', async () => {
    const out = await startSignIn('agenfold-blind');
    expect(code(out), JSON.stringify(out)).toBe('SUPPORT_OWNER_IDENTITY_UNDECLARED');
    expect(JSON.stringify(out)).toContain('openid');
    expect(JSON.stringify(out)).toContain('ownerSignIn.userinfoUrl');
    const [started] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM support_owner_sign_ins
       WHERE binding_id IN (${bindings['agenfold-open']}::uuid, ${bindings['agenfold-blind']}::uuid)`);
    expect(started?.n).toBe(0);
  });
});
