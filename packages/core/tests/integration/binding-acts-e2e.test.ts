/**
 * ISS-1421 r27 — judge-108: a plain project member was offered acts the binding doors then refused
 * with a bare "Forbidden.", because the doors (`assertAdmin`), the drawer (`useOrgConnectionLocked`)
 * and the refusal sentences (`removedReaderOf`) each answered "who may" by a rule of their own. The
 * project's list now says what each reader may do, by the rule the doors refuse by, and every
 * refusal says what, why and who. Through the real app against real Postgres.
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
type Acts = {
  change: boolean;
  saveKey: boolean;
  turnOn: boolean;
  grantAgents: boolean;
  whoChanges: string;
  whoSavesKey: string;
};

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let store: Store;
let signUserToken: (userId: string) => Promise<string>;

/** The org's owner, a project admin who is a plain org member, and a plain member of both. */
let owner: { id: string; token: string };
let admin: { id: string; token: string };
let member: { id: string; token: string };
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
  const { registerAllIntegrations } = await import('../../src/integrations/register-all.js');
  registerAllIntegrations();
  ({ signUserToken } = await import('../../src/auth/jwt.js'));

  owner = await person('acts-owner');
  admin = await person('acts-admin');
  member = await person('acts-member');
  orgId = (await seedOrg(harness.db, owner.id)).id;
  for (const p of [admin, member]) await createTestOrgMember(harness.db, { orgId, userId: p.id });
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

async function actsOf(bearer: string, bindingId: string): Promise<Acts> {
  const list = await callAs(bearer, 'GET', `/api/projects/${projectId}/integrations`);
  expect(list.status).toBe(200);
  const row = (list.body.items as Array<{ id: string; acts: Acts }>).find(
    (b) => b.id === bindingId,
  );
  if (!row) throw new Error('binding missing from the list');
  return row.acts;
}

async function rowOf(bindingId: string) {
  const pair = await store.findBindingWithConnectionById(bindingId);
  return {
    bindingActive: pair?.binding.active,
    connectionActive: pair?.connection.active,
    secrets: pair?.connection.secretsEnc?.toString('base64'),
    updatedAt: String(pair?.connection.updatedAt),
  };
}

const patch = (bearer: string, bindingId: string, body: unknown) =>
  callAs(bearer, 'PATCH', `/api/projects/${projectId}/integrations/${bindingId}`, body);

describe('a plain project member over a removed connection (criteria 290, 308, 309)', () => {
  it("answers a member's keyless switch-on 409 CONNECTION_REMOVED, as it answers the owner", async () => {
    const { bindingId } = await sentryBinding({ type: 'org', id: orgId }, true);
    await store.updateBinding(bindingId, { active: false });
    for (const body of [
      { active: true },
      { active: true, secrets: {} },
      { active: true, secrets: { authToken: '' } },
    ]) {
      const said = await patch(member.token, bindingId, body);
      expect(said.status, JSON.stringify(said.body)).toBe(409);
      expect(said.body.code).toBe('CONNECTION_REMOVED');
      expect(said.body.message).toContain(
        'Only an owner or admin of the organization that owns it can save a new key',
      );
    }
  });

  it("refuses a member's key save naming who may, and leaves everything as it was", async () => {
    const org = { ...(await sentryBinding({ type: 'org', id: orgId }, true)), projectId };
    const person = { ...(await sentryBinding({ type: 'user', id: owner.id }, true)), projectId };
    for (const [{ bindingId, projectId: at }, who] of [
      [org, 'only an owner or admin of that organization can change its key'],
      [person, 'only its owner or an admin of a project bound to it can change its key'],
    ] as const) {
      projectId = at;
      const before = await rowOf(bindingId);
      const said = await patch(member.token, bindingId, { secrets: { authToken: 'scratch-new' } });
      expect(said.status, JSON.stringify(said.body)).toBe(403);
      expect(said.body.message).toContain(who);
      expect(said.body.message).not.toBe('Forbidden.');
      expect(await rowOf(bindingId)).toEqual(before);
    }
  });
});

describe('the list says what each reader may do, and the doors agree (criteria 310, 311, 316)', () => {
  it('offers a plain member nothing on an organization binding, and refuses each act by name', async () => {
    const { bindingId } = await sentryBinding({ type: 'org', id: orgId });
    const acts = await actsOf(member.token, bindingId);
    expect(acts).toMatchObject({
      change: false,
      saveKey: false,
      turnOn: false,
      grantAgents: false,
    });
    expect(acts.whoChanges).toBe('an admin of this project');

    const switched = await patch(member.token, bindingId, { active: false });
    expect(switched.status).toBe(403);
    expect(switched.body.message).toBe(
      'You are a member of this project, so you cannot switch this integration or change its settings here. Only an admin of this project can, so ask one of them.',
    );
    const gone = await callAs(
      member.token,
      'DELETE',
      `/api/projects/${projectId}/integrations/${bindingId}`,
    );
    expect(gone.status).toBe(403);
    expect(gone.body.message).toContain('you cannot disconnect this integration from it');
    const rotated = await callAs(
      member.token,
      'POST',
      `/api/projects/${projectId}/integrations/${bindingId}/rotate-secret`,
    );
    expect(rotated.status).toBe(403);
    expect(rotated.body.message).toContain("you cannot rotate this integration's inbound secret");
    expect((await rowOf(bindingId)).bindingActive).toBe(true);
  });

  it('lets a project admin switch it, and refuses the organization key by name', async () => {
    const { bindingId } = await sentryBinding({ type: 'org', id: orgId });
    const acts = await actsOf(admin.token, bindingId);
    expect(acts).toMatchObject({ change: true, saveKey: false, turnOn: false });
    expect((await patch(admin.token, bindingId, { active: false })).status).toBe(200);
    const keyed = await patch(admin.token, bindingId, { secrets: { authToken: 'scratch-new' } });
    expect(keyed.status).toBe(403);
    expect(keyed.body.message).toContain(
      'only an owner or admin of that organization can change its key',
    );
  });

  it("lets a connection's owner save its key while only a member of the project, and nothing else", async () => {
    const { bindingId } = await sentryBinding({ type: 'user', id: member.id });
    const acts = await actsOf(member.token, bindingId);
    expect(acts).toMatchObject({ change: false, saveKey: true, turnOn: true });
    const keyed = await patch(member.token, bindingId, { secrets: { authToken: 'scratch-new' } });
    expect(keyed.status, JSON.stringify(keyed.body)).toBe(200);
    expect((keyed.body.integration as { acts: Acts }).acts.saveKey).toBe(true);
    const switched = await patch(member.token, bindingId, {
      active: false,
      secrets: { authToken: 'x2' },
    });
    expect(switched.status).toBe(403);
    expect(switched.body.message).toContain('switch this integration or change its settings');
  });

  it('answers the project-wide acts on the list, and refuses a member connecting a provider by name', async () => {
    const asMember = await callAs(member.token, 'GET', `/api/projects/${projectId}/integrations`);
    expect(asMember.body.may).toMatchObject({
      connect: false,
      whoConnects: 'an admin of this project',
    });
    const asAdmin = await callAs(admin.token, 'GET', `/api/projects/${projectId}/integrations`);
    expect((asAdmin.body.may as { connect: boolean }).connect).toBe(true);
    const made = await callAs(member.token, 'POST', `/api/projects/${projectId}/integrations`, {
      provider: 'sentry',
      role: 'service',
      config: { host: 'https://sentry.example' },
      secrets: { authToken: 'scratch-token' },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(403);
    expect(made.body.message).toContain('you cannot connect an integration to it');
  });

  it('names a reader outside the project, never "Forbidden."', async () => {
    const outsider = await person('acts-outsider');
    await createTestOrgMember(harness.db, { orgId, userId: outsider.id });
    const said = await callAs(outsider.token, 'GET', `/api/projects/${projectId}/integrations`);
    expect(said.status).toBe(403);
    expect(said.body.message).toContain('You are not a member of this project');
  });
});

describe("a connection's own refusals and bindings (criteria 317, 318)", () => {
  it('says a connection cannot be reached without its id', async () => {
    const id = randomUUID();
    const said = await callAs(member.token, 'GET', `/api/integration-connections/${id}/bindings`);
    expect(said.status).toBe(404);
    expect(said.body.message).toMatch(/^This connection is not one you can reach\./);
    expect(String(said.body.message)).not.toContain(id);
  });

  it("lists the reader's own project among those using a person's connection they do not reach", async () => {
    const { connectionId } = await sentryBinding({ type: 'user', id: owner.id });
    const said = await callAs(
      member.token,
      'GET',
      `/api/integration-connections/${connectionId}/bindings`,
    );
    expect(said.status, JSON.stringify(said.body)).toBe(200);
    expect((said.body.items as Array<{ projectId: string }>).map((b) => b.projectId)).toContain(
      projectId,
    );
  });
});
