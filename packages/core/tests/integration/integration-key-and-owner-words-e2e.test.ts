/**
 * ISS-1421 r29 — the words two doors gave on this surface. A key sent to a provider that keeps none
 * was refused one way by the creates and another by the PATCH, and an empty one was taken (334,
 * 335); a person's connection whose owner set no name said "Ask the member who owns it", naming
 * nobody the reader could find (judge-119 on 331, criterion 338). Through the real app against real
 * Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Store = typeof import('../../src/integrations/store.js');
type Json = Record<string, unknown>;
type Registry = typeof import('../../src/integrations/registry.js');

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let store: Store;
let registry: Registry;
let signUserToken: (userId: string) => Promise<string>;

/** The org's owner, a project admin who is a plain org member, a plain member of both, and a viewer. */
let owner: { id: string; token: string };
let admin: { id: string; token: string };
let member: { id: string; token: string };
let viewer: { id: string; token: string };
let orgId: string;
let projectId: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.PUBLIC_API_BASE_URL = 'http://localhost';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
  store = await import('../../src/integrations/store.js');
  registry = await import('../../src/integrations/registry.js');
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
  ({ signUserToken } = await import('../../src/auth/jwt.js'));

  owner = await person('acts-owner');
  admin = await person('acts-admin');
  member = await person('acts-member');
  viewer = await person('acts-viewer');
  orgId = (await seedOrg(harness.db, owner.id)).id;
  for (const p of [admin, member, viewer])
    await createTestOrgMember(harness.db, { orgId, userId: p.id });
  projectId = await freshProject();
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function person(name: string) {
  const user = await createTestUser(harness.db, {
    email: `${name}-${randomUUID().slice(0, 6)}@test.forge.local`,
  });
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  return { id: user.id, token: await signUserToken(user.id) };
}

async function callAs(bearer: string, method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
}

/** A project of the org's own, where `admin` administers and `member` is a plain member. */
async function freshProject() {
  const id = (await createTestProject(harness.db, owner.id, { orgId })).id;
  await createTestProjectMember(harness.db, { userId: admin.id, projectId: id, role: 'admin' });
  await createTestProjectMember(harness.db, { userId: member.id, projectId: id, role: 'member' });
  await createTestProjectMember(harness.db, { userId: viewer.id, projectId: id, role: 'viewer' });
  return id;
}

/** A Sentry connection owned by `ownerOf`, bound to a fresh project; removed by its owner where asked. */
async function sentryBinding(ownerOf: { type: 'user' | 'org'; id: string }, removed = false) {
  projectId = await freshProject();
  const connection = await store.createConnection({
    ownerType: ownerOf.type,
    ownerId: ownerOf.id,
    provider: 'sentry',
    displayName: `sentry ${randomUUID().slice(0, 6)}`,
    config: { host: 'https://sentry.example' },
    secrets: { authToken: 'scratch-held-token' },
  });
  const binding = await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'sentry',
    role: 'service',
  });
  if (removed) {
    const by = ownerOf.type === 'org' ? owner.token : await signUserToken(ownerOf.id);
    expect(
      (await callAs(by, 'DELETE', `/api/integration-connections/${connection.id}`)).status,
    ).toBe(200);
  }
  return { connectionId: connection.id, bindingId: binding.id };
}

// ISS-1421 r29: the creates refused a key to a provider that keeps none in their schema's words, the
// PATCH in its own, and the PATCH took an empty set of keys 200 (criteria 334, 335).
describe('a key sent to a provider that keeps none (criteria 334, 335)', () => {
  it('is refused by every door that saves one, in the one sentence, an empty set of keys included', async () => {
    const keyless = registry.listIntegrations().find((d) => !d.schemas.primaryCredentialField);
    if (!keyless) throw new Error('no provider keeps no key');
    const { noKeyToSaveMessage } = await import('../../src/integrations/provider-schemas.js');
    const sentence = noKeyToSaveMessage(keyless.provider);
    projectId = await freshProject();
    const created = await callAs(owner.token, 'POST', `/api/projects/${projectId}/integrations`, {
      provider: keyless.provider,
      role: 'deploy',
      stages: ['live'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bindingId = String((created.body.integration as Json).id);
    const pair = await store.findBindingWithConnectionById(bindingId);
    if (!pair) throw new Error('the keyless create left no binding');
    for (const secrets of [{ token: 'scratch-key' }, {}]) {
      const at = JSON.stringify(secrets);
      for (const [door, method, url, body] of [
        [
          'project create',
          'POST',
          `/api/projects/${projectId}/integrations`,
          { provider: keyless.provider, role: 'deploy', stages: ['preview'], secrets },
        ],
        [
          'connection create',
          'POST',
          '/api/integration-connections',
          { provider: keyless.provider, secrets },
        ],
        [
          'binding PATCH',
          'PATCH',
          `/api/projects/${projectId}/integrations/${bindingId}`,
          { secrets },
        ],
        [
          'connection PATCH',
          'PATCH',
          `/api/integration-connections/${pair.connection.id}`,
          { secrets },
        ],
      ] as const) {
        const said = await callAs(owner.token, method, url, body);
        expect(said.status, `${door} ${at}: ${JSON.stringify(said.body)}`).toBe(400);
        expect(said.body.message, `${door} ${at}`).toBe(sentence);
      }
    }
  });
});

describe('a key sent with a share is refused, never dropped', () => {
  it('refuses a share carrying a key, saying the connection keeps its own, and binds nothing', async () => {
    const { connectionId } = await sentryBinding({ type: 'org', id: orgId });
    const target = await freshProject();
    const { SHARE_TAKES_NO_KEY } = await import('../../src/integrations/provider-schemas.js');
    const said = await callAs(
      owner.token,
      'POST',
      `/api/integration-connections/${connectionId}/bindings`,
      { projectId: target, role: 'service', secrets: { authToken: 'scratch-other-token' } },
    );
    expect(said.status, JSON.stringify(said.body)).toBe(400);
    expect(said.body.message).toBe(SHARE_TAKES_NO_KEY);
    expect(String(said.body.message)).not.toMatch(/secrets|field/);
    const bound = (await store.listBindingsForProject(target)).filter(
      (p) => p.connection.id === connectionId,
    );
    expect(bound).toHaveLength(0);
  });
});

// ISS-1421 r29, judge-119 on 331: "Ask the member who owns it" named nobody a reader could find
// where the owner set no display name (criterion 338).
describe('a nameless owner is named as the Members list shows them (criterion 338)', () => {
  it("names the row the reader's organization's Members list draws for the owner", async () => {
    const { listedAs } = await import('@forge/contracts/people-apart');
    const { connectionId } = await sentryBinding({ type: 'user', id: owner.id });
    // The project's admin reaches a person's connection through its binding and may not change it.
    const said = await callAs(
      admin.token,
      'PATCH',
      `/api/integration-connections/${connectionId}`,
      {
        displayName: 'renamed',
      },
    );
    expect(said.status, JSON.stringify(said.body)).toBe(403);
    const members = await callAs(admin.token, 'GET', `/api/orgs/${orgId}/members`);
    expect(members.status).toBe(200);
    const people = (members.body as unknown as Array<Json>)
      .filter((m) => m.kind !== 'agent')
      .map((m) => ({
        userId: String(m.userId),
        displayName: (m.displayName as string | null) ?? null,
        addedAt: String(m.createdAt),
      }));
    const row = people.find((p) => p.userId === owner.id);
    if (!row) throw new Error('the owner is not on the Members list');
    const [org] = (await harness.db.execute(
      sql`SELECT name FROM organizations WHERE id = ${orgId}`,
    )) as unknown as Array<{ name: string }>;
    const orgName = org?.name;
    expect(said.body.message).toContain(
      `Ask the member listed as "${listedAs(row, people, admin.id)}" under Members in ${String(orgName)},`,
    );
    expect(said.body.message).toContain('a member who has set no name Forge can show');
  });
});
