/**
 * ISS-1421 r29 — judge-119 on 316: the rollback images of a project whose Coolify connection was
 * removed answered 400 "No active Coolify integration with that integrationId." and "Project has no
 * active Coolify integration.", naming an API parameter, no why and nobody, while the application
 * list over the same binding answered 409 CONNECTION_REMOVED. And on 336: Test connection told a
 * plain member to check an address only the connection's key-savers may change. Through the real
 * app against real Postgres.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
type Json = Record<string, unknown>;

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;
let store: typeof import('../../src/integrations/store.js');
let signUserToken: (userId: string) => Promise<string>;

let owner: { id: string; token: string };
let admin: { id: string; token: string };
let member: { id: string; token: string };
let viewer: { id: string; token: string };
let orgId: string;

/** A host no resolver answers, so a check fails before any network is reached. */
const NOWHERE = 'https://coolify.iss-1421-r29.invalid';
/** A host this file's fetch stub answers 401 for, as a Coolify that refuses the stored token. */
const REFUSES_TOKEN = 'https://coolify-refuses.iss-1421-r29.invalid';

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

  owner = await person('off-owner');
  admin = await person('off-admin');
  member = await person('off-member');
  viewer = await person('off-viewer');
  orgId = (await seedOrg(harness.db, owner.id)).id;
  for (const p of [admin, member, viewer]) {
    await createTestOrgMember(harness.db, { orgId, userId: p.id });
  }
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

/** An organization's live Coolify, bound to a fresh project of the org's as its live deploy target. */
async function coolifyProject(baseUrl = NOWHERE) {
  const projectId = (await createTestProject(harness.db, owner.id, { orgId })).id;
  await createTestProjectMember(harness.db, { userId: admin.id, projectId, role: 'admin' });
  await createTestProjectMember(harness.db, { userId: member.id, projectId, role: 'member' });
  await createTestProjectMember(harness.db, { userId: viewer.id, projectId, role: 'viewer' });
  const connection = await store.createConnection({
    ownerType: 'org',
    ownerId: orgId,
    provider: 'coolify',
    displayName: `coolify ${randomUUID().slice(0, 6)}`,
    config: { baseUrl },
    secrets: { apiToken: 'scratch-made-up-token' },
  });
  const binding = await store.createBinding({
    connectionId: connection.id,
    projectId,
    provider: 'coolify',
    role: 'deploy',
    stages: ['live'],
    config: { targets: [{ id: 'web', label: 'Web', resourceUuid: 'made-up-uuid' }] },
  });
  return { projectId, connectionId: connection.id, bindingId: binding.id };
}

const images = (bearer: string, projectId: string, bindingId?: string) =>
  callAs(
    bearer,
    'GET',
    `/api/projects/${projectId}/integrations/coolify/rollback-images${bindingId ? `?integrationId=${bindingId}` : ''}`,
  );

const readers = () => ({ owner, admin, member });

describe('a Coolify read over a binding that answers nothing says why and who may (criterion 316)', () => {
  it('answers a removed connection 409 CONNECTION_REMOVED, naming who may save a new key, for every reader', async () => {
    const { projectId, connectionId, bindingId } = await coolifyProject();
    const removed = await callAs(
      owner.token,
      'DELETE',
      `/api/integration-connections/${connectionId}`,
    );
    expect(removed.status).toBe(200);
    const listed = await callAs(
      admin.token,
      'POST',
      `/api/projects/${projectId}/integrations/coolify/applications`,
      {
        integrationId: bindingId,
      },
    );
    expect(listed.body.code, 'the application list over the same binding').toBe(
      'CONNECTION_REMOVED',
    );
    for (const [name, reader] of Object.entries(readers())) {
      for (const named of [bindingId, undefined]) {
        const at = `${name}, ${named ? 'naming the binding' : 'naming none'}`;
        const said = await images(reader.token, projectId, named);
        expect(said.status, `${at}: ${JSON.stringify(said.body)}`).toBe(409);
        expect(said.body.code, at).toBe('CONNECTION_REMOVED');
        const message = String(said.body.message);
        expect(message, at).toContain('the connection behind it was removed and holds no key');
        expect(message, at).toContain(
          'Only an owner or admin of the organization that owns it can save a new key to turn it back on.',
        );
        expect(message, at).not.toMatch(/integrationId|No active Coolify/);
      }
    }
  });

  it('says a switched-off connection is off for every project, and who turns it back on', async () => {
    const { projectId, connectionId, bindingId } = await coolifyProject();
    const off = await callAs(owner.token, 'PATCH', `/api/integration-connections/${connectionId}`, {
      active: false,
    });
    expect(off.status).toBe(200);
    const said = await images(member.token, projectId, bindingId);
    expect(said.status, JSON.stringify(said.body)).toBe(400);
    expect(String(said.body.message)).toContain(
      'the connection behind it is switched off for every project sharing it. Only an owner or admin of the organization that owns it can turn it back on',
    );
    expect(String(said.body.message)).not.toContain('integrationId');
  });

  it("says a binding switched off for this project is, and that this project's admin switches it on", async () => {
    const { projectId, bindingId } = await coolifyProject();
    await store.updateBinding(bindingId, { active: false });
    const said = await callAs(
      admin.token,
      'POST',
      `/api/projects/${projectId}/integrations/coolify/cancel`,
      {},
    );
    expect(said.status, JSON.stringify(said.body)).toBe(400);
    expect(String(said.body.message)).toContain(
      'it is switched off for this project, and an admin of this project can switch it back on',
    );
  });

  it('says a project with no Coolify has none, and who may connect one', async () => {
    const projectId = (await createTestProject(harness.db, owner.id, { orgId })).id;
    const said = await images(owner.token, projectId);
    expect(said.status).toBe(400);
    expect(said.body.message).toBe(
      "This project has no Coolify connected. Only an admin of this project can connect it, on the project's Integrations tab. Nothing was asked of Coolify.",
    );
  });

  it("says a binding named that is not this project's Coolify is none of its own", async () => {
    const { projectId } = await coolifyProject();
    const said = await images(owner.token, projectId, randomUUID());
    expect(said.status).toBe(400);
    expect(String(said.body.message)).toContain("None of this project's Coolify bindings has");
    expect(String(said.body.message)).not.toContain('integrationId');
  });

  it('says a project with several Coolify bindings and none named cannot tell which, naming no parameter', async () => {
    const { projectId, connectionId } = await coolifyProject();
    await store.createBinding({
      connectionId,
      projectId,
      provider: 'coolify',
      role: 'deploy',
      stages: ['preview'],
      config: { targets: [{ id: 'api', label: 'Api', resourceUuid: 'made-up-uuid-2' }] },
    });
    const said = await images(owner.token, projectId);
    expect(said.status).toBe(400);
    expect(String(said.body.message)).toContain('2 Coolify bindings switched on');
    expect(String(said.body.message)).not.toContain('integrationId');
  });
});

describe('Test connection names who may change the address its reader may not (criterion 336)', () => {
  it('tells a plain member who may change the address, and the org owner to check it', async () => {
    const { projectId, bindingId } = await coolifyProject();
    const test = (bearer: string) =>
      callAs(bearer, 'POST', `/api/projects/${projectId}/integrations/${bindingId}/test`);

    const toMember = String((await test(member.token)).body.message);
    expect(toMember).toMatch(/^Forge could not reach Coolify/);
    expect(toMember).not.toMatch(/Check (that )?the address/);
    expect(toMember).toContain(
      'Only an owner or admin of the organization that owns it can change the address',
    );
    expect(toMember).toContain('so ask one of them');

    const toOwner = String((await test(owner.token)).body.message);
    expect(toOwner).toMatch(/Check (that )?the address/);
    expect(toOwner).not.toContain('ask one of them');
  });

  it('tells a plain member reading the bound targets or rollback images who may change the address, never to check it', async () => {
    const { projectId, bindingId } = await coolifyProject(REFUSES_TOKEN);
    const realFetch = globalThis.fetch;
    const stub = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) =>
        new URL(input instanceof Request ? input.url : String(input)).host ===
        new URL(REFUSES_TOKEN).host
          ? new Response('{"message":"Unauthenticated."}', { status: 401 })
          : realFetch(input, init),
      );
    try {
      for (const path of ['targets', 'rollback-images']) {
        for (const named of [bindingId, undefined]) {
          const at = `${path}, ${named ? 'naming the binding' : 'naming none'}`;
          const url = `/api/projects/${projectId}/integrations/coolify/${path}${named ? `?integrationId=${named}` : ''}`;
          const toOwner = String((await callAs(owner.token, 'GET', url)).body.message);
          expect(toOwner, at).toContain(
            'If it is not, check the address saved on this connection.',
          );
          const toMember = String((await callAs(member.token, 'GET', url)).body.message);
          expect(toMember, at).toMatch(/refused the stored API token/);
          expect(toMember, at).not.toMatch(/check the address/i);
          expect(toMember, at).toContain(
            'only an owner or admin of the organization that owns it can save a new one to this connection',
          );
          expect(toMember, at).toContain(
            'If it is not, only an owner or admin of the organization that owns it can change the address',
          );
        }
      }
    } finally {
      stub.mockRestore();
    }
  });
});

/** Every request this app sends out while `fn` runs, by host. */
async function hostsAskedDuring(fn: () => Promise<void>): Promise<string[]> {
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    asked.push(new URL(input instanceof Request ? input.url : String(input)).host);
    return realFetch(input, init);
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return asked;
}

const applications = (bearer: string, projectId: string, bindingId: string) =>
  callAs(bearer, 'POST', `/api/projects/${projectId}/integrations/coolify/applications`, {
    integrationId: bindingId,
  });

// ISS-1421 r30, judge-122 on 316 and 336.
describe('round 30: every Coolify door says why it refuses, and who may', () => {
  it('refuses the application list over a switched-off connection as off, sending no token', async () => {
    const { projectId, connectionId, bindingId } = await coolifyProject();
    await callAs(owner.token, 'PATCH', `/api/integration-connections/${connectionId}`, {
      active: false,
    });
    let said = { status: 0, body: {} as Json };
    const asked = await hostsAskedDuring(async () => {
      said = await applications(member.token, projectId, bindingId);
    });
    expect(said.status, JSON.stringify(said.body)).toBe(400);
    expect(String(said.body.message)).toContain(
      'the connection behind it is switched off for every project sharing it. Only an owner or admin of the organization that owns it can turn it back on',
    );
    expect(asked).not.toContain(new URL(NOWHERE).host);
  });

  it('refuses the application list over a binding switched off for this project as off, sending no token', async () => {
    const { projectId, bindingId } = await coolifyProject();
    await store.updateBinding(bindingId, { active: false });
    let said = { status: 0, body: {} as Json };
    const asked = await hostsAskedDuring(async () => {
      said = await applications(member.token, projectId, bindingId);
    });
    expect(said.status, JSON.stringify(said.body)).toBe(400);
    expect(String(said.body.message)).toContain(
      'it is switched off for this project, and an admin of this project can switch it back on',
    );
    expect(asked).not.toContain(new URL(NOWHERE).host);
  });

  it('names who may change the address when the application list cannot reach it, and tells the owner to check it', async () => {
    const { projectId, bindingId } = await coolifyProject();
    const toMember = await applications(member.token, projectId, bindingId);
    expect(toMember.status).toBe(424);
    expect(String(toMember.body.message)).toContain(
      'Only an owner or admin of the organization that owns it can change the address saved on this connection, so ask one of them.',
    );
    expect(String(toMember.body.message)).not.toMatch(/Check the address/);
    const toOwner = await applications(owner.token, projectId, bindingId);
    expect(String(toOwner.body.message)).toContain('Check the address saved on this connection.');
  });

  it.each([
    ['deploy', {}, 'deploy it through Coolify'],
    ['cancel', {}, 'cancel a Coolify deploy for it'],
    ['rollback', { commit: 'made-up-commit' }, 'roll it back through Coolify'],
  ])("refuses a viewer's %s naming the act and who may take it", async (door, body, act) => {
    const { projectId } = await coolifyProject();
    const said = await callAs(
      viewer.token,
      'POST',
      `/api/projects/${projectId}/integrations/coolify/${door}`,
      body,
    );
    expect(said.status).toBe(403);
    expect(said.body.message).toBe(
      `You are a viewer of this project, so you cannot ${act}. Only a member or admin of this project can, so ask one of them.`,
    );
  });
});
