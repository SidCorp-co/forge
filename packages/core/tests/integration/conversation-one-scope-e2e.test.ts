/**
 * ISS-1229 r33 — judge-92: what a room is about had two answers. The read door goes by the project each
 * live agent was added for (`derivedScope`); the room list matched an agent's current project role. So a
 * room whose only agent lost its role opened (200) and was in no list, and an agent holding a role on a
 * second project listed its room under a project the room is not about. One answer now: the scope.
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
type Listed = { items: Array<{ id: string; scope: string[] }>; total: number };
type Named = { id: string; name: string; slug: string };
type Candidates = {
  handles: Array<{ project: Named }>;
  beyondReach: { named: Named[]; unnamed: number };
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
let memberId: string;
let deskId: string;
let ledgerId: string;
let opsId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

async function grant(projectId: string, userId: string, role: string): Promise<void> {
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${userId}, ${role})`,
  );
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = await verifiedUser();
  memberId = await verifiedUser();
  const orgId = (await seedOrg(harness.db, ownerId)).id;
  await harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${memberId}, 'member')`,
  );
  deskId = (await createTestProject(harness.db, ownerId, { slug: 'desk', name: 'Desk', orgId })).id;
  ledgerId = (
    await createTestProject(harness.db, ownerId, { slug: 'ledger', name: 'Ledger', orgId })
  ).id;
  opsId = (await createTestProject(harness.db, ownerId, { slug: 'ops', name: 'Ops', orgId })).id;
  await grant(deskId, memberId, 'member');
});

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

/** A room the owner opens about one project, its agent in it. */
async function roomAbout(projectId: string, people: string[] = []): Promise<string> {
  const opened = await as(ownerId, '/api/conversations', 'POST', {
    projectId,
    title: 'Footer notes',
    people,
  });
  expect(opened.status, await opened.clone().text()).toBe(201);
  return ((await opened.json()) as { id: string }).id;
}

async function agentOf(roomId: string): Promise<string> {
  const rows = await harness.db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM conversation_participants WHERE conversation_id = ${roomId} AND kind = 'handle' AND removed_at IS NULL ORDER BY added_at LIMIT 1`,
  );
  return String(rows[0]?.user_id);
}

async function listed(userId: string, projectId: string): Promise<Listed> {
  const res = await as(userId, `/api/conversations?projectId=${projectId}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Listed;
}

describe('one answer to what a room is about', () => {
  it('keeps a room whose only agent lost its role in its project list, where it still opens', async () => {
    const room = await roomAbout(deskId);
    const agent = await agentOf(room);
    await harness.db.execute(
      sql`DELETE FROM project_members WHERE project_id = ${deskId} AND user_id = ${agent}`,
    );

    expect((await as(ownerId, `/api/conversations/${room}`)).status).toBe(200);
    const desk = await listed(ownerId, deskId);
    expect(desk.items.map((r) => r.id)).toEqual([room]);
    expect(desk.total).toBe(1);
    expect(desk.items[0]?.scope).toEqual([deskId]);
  });

  it('lists a room under no project it is not about, whatever else its agent holds a role on', async () => {
    const room = await roomAbout(deskId);
    await grant(ledgerId, await agentOf(room), 'member');

    expect((await listed(ownerId, ledgerId)).items.map((r) => r.id)).toEqual([]);
    expect((await listed(ownerId, deskId)).items.map((r) => r.id)).toEqual([room]);
  });

  it('carries the same scope on a two-project room in both its lists', async () => {
    const room = await roomAbout(deskId);
    const added = await as(ownerId, `/api/conversations/${room}/handles`, 'POST', {
      projectId: ledgerId,
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const scope = [deskId, ledgerId].sort();

    for (const projectId of [deskId, ledgerId]) {
      const rows = (await listed(ownerId, projectId)).items;
      expect(rows.map((r) => [r.id, r.scope])).toEqual([[room, scope]]);
    }
  });

  it('lists only what the reader can open: a room on a project they hold no role on is not theirs', async () => {
    const room = await roomAbout(deskId, [memberId]);
    await as(ownerId, `/api/conversations/${room}/handles`, 'POST', { projectId: ledgerId });

    expect((await as(memberId, `/api/conversations/${room}`)).status).toBe(403);
    expect((await listed(memberId, deskId)).items.map((r) => r.id)).toEqual([]);
  });

  it('answers a turn by an agent added for its project, never one added for another', async () => {
    const { handleForProject } = await import('../../src/conversations/participants.js');
    const room = await roomAbout(deskId);
    const agent = await agentOf(room);
    await grant(ledgerId, agent, 'member');

    expect(await handleForProject(room, deskId)).toBe(agent);
    expect(await handleForProject(room, ledgerId)).toBeNull();
  });
});

describe('agents the reader cannot add', () => {
  it('names a project the reader can see and counts one they cannot, and offers neither', async () => {
    await grant(opsId, memberId, 'viewer');
    const opened = await as(memberId, '/api/conversations', 'POST', { projectId: deskId });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const room = ((await opened.json()) as { id: string }).id;

    const res = await as(memberId, `/api/conversations/${room}/candidates`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Candidates;
    expect(body.handles.map((h) => h.project.id)).toEqual([]);
    expect(body.beyondReach.named.map((p) => p.name)).toEqual(['Ops']);
    expect(body.beyondReach.unnamed).toBe(1);
    expect(JSON.stringify(body)).not.toContain('Ledger');

    const before = await as(memberId, `/api/conversations/candidates?projectId=${deskId}`);
    const opening = (await before.json()) as Candidates;
    expect([opening.beyondReach.named.map((p) => p.name), opening.beyondReach.unnamed]).toEqual([
      ['Ops'],
      1,
    ]);
  });

  it('leaves nothing beyond reach for an admin, who can add every project agent', async () => {
    const room = await roomAbout(deskId);
    const body = (await (
      await as(ownerId, `/api/conversations/${room}/candidates`)
    ).json()) as Candidates;
    expect(body.handles.map((h) => h.project.name).sort()).toEqual(['Ledger', 'Ops']);
    expect(body.beyondReach).toEqual({ named: [], unnamed: 0 });
  });
});
