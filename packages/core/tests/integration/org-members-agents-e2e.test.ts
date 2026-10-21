/**
 * ISS-1229 r28 — judge-80 found the organization page listing project agents as members, with lens
 * chips, a role and a remove control, and the agent of a deleted project still listed. The members
 * route now says which rows are agents and which of the organization's projects each serves, so the
 * page lists them apart and leaves out one that serves none. Taking out or demoting the only owner
 * says what to do instead.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Member = {
  userId: string;
  kind: 'person' | 'agent';
  projects: Array<{ id: string; name: string }>;
};

let harness: TestDatabase;
let app: import('hono').Hono<AppVars>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  ({ app } = (await import('../../src/index.js')) as unknown as {
    app: import('hono').Hono<AppVars>;
  });
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let orgId: string;

async function verifiedUser(kind: 'human' | 'agent' = 'human'): Promise<string> {
  const id = (await createTestUser(harness.db, { kind })).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

async function as(userId: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${await signUserToken(userId)}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function agentOf(handle: string, projectIds: string[]): Promise<string> {
  const id = await verifiedUser('agent');
  await harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role, handle) VALUES (${orgId}, ${id}, 'member', ${handle})`,
  );
  for (const projectId of projectIds) {
    await harness.db.execute(
      sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${id}, 'member')`,
    );
  }
  return id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = await verifiedUser();
  orgId = (await seedOrg(harness.db, ownerId)).id;
});

describe("an organization's members", () => {
  it('say which are agents, and which of its projects each agent serves', async () => {
    const billing = (
      await createTestProject(harness.db, ownerId, { slug: 'billing', name: 'Billing', orgId })
    ).id;
    const retired = (
      await createTestProject(harness.db, ownerId, { slug: 'retired', name: 'Retired', orgId })
    ).id;
    const both = await agentOf('ops', [retired, billing]);
    const gone = await agentOf('retired', [retired]);
    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${retired}`);

    const res = await as(ownerId, `/api/orgs/${orgId}/members`);
    expect(res.status, await res.clone().text()).toBe(200);
    const members = (await res.json()) as Member[];
    const read = (id: string) => {
      const m = members.find((row) => row.userId === id);
      return m && { kind: m.kind, projects: m.projects.map((p) => p.name) };
    };
    expect(read(ownerId)).toEqual({ kind: 'person', projects: [] });
    expect(read(both)).toEqual({ kind: 'agent', projects: ['Billing'] });
    // The account stays (it may hold a device or have spoken in a room); it serves nothing here now.
    expect(read(gone)).toEqual({ kind: 'agent', projects: [] });
  });
});

describe('the only owner', () => {
  it('cannot be taken out or demoted, and is told to make someone else an owner first', async () => {
    const sentence = 'Make someone else an owner first — an organization keeps at least one owner.';
    const leave = await as(ownerId, `/api/orgs/${orgId}/members/${ownerId}`, 'DELETE');
    expect(leave.status).toBe(409);
    expect(await leave.json()).toMatchObject({ code: 'LAST_OWNER', message: sentence });
    const demote = await as(ownerId, `/api/orgs/${orgId}/members/${ownerId}`, 'PATCH', {
      role: 'admin',
    });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ code: 'LAST_OWNER', message: sentence });
  });
});
