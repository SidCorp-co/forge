// ISS-1034 — a Forge room's shape follows who is in it, against a real Postgres:
// a second person turns a one-to-one chat into a group and the room is told
// who joined; the last other person leaving turns it back with a line naming
// why; two handles keep a room a group whoever leaves; and a person no longer
// in a one-to-one room is refused its transcript.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestOrgMember,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
let harness: TestDatabase;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let ownerId: string;
let otherId: string;
let thirdId: string;
let orgId: string;
let projectId: string;
let ownerAuth: string;
let otherAuth: string;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { conversationMemberRoutes } = await import(
    '../../src/assistant/conversation-member-routes.js'
  );
  const { webConversationPorts } = await import('../../src/assistant/conversation-adapter.js');
  const { registerConversationTransport } = await import('../../src/conversations/ports.js');
  registerConversationTransport(webConversationPorts);
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono();
  app.use('*', requestId());
  app.route('/api/conversations', conversationRoutes);
  app.route('/api/conversations', conversationMemberRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

async function member(orgId: string, projectId: string): Promise<{ id: string; auth: string }> {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  await createTestOrgMember(harness.db, { orgId, userId: user.id });
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${user.id}, 'member') ON CONFLICT DO NOTHING`,
  );
  const { signUserToken } = await import('../../src/auth/jwt.js');
  return { id: user.id, auth: `Bearer ${await signUserToken(user.id)}` };
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  const org = await seedOrg(harness.db, ownerId);
  orgId = org.id;
  projectId = (
    await createTestProject(harness.db, ownerId, {
      orgId,
      slug: `alpha-${randomUUID().slice(0, 8)}`,
    })
  ).id;
  const other = await member(orgId, projectId);
  otherId = other.id;
  otherAuth = other.auth;
  thirdId = (await member(orgId, projectId)).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  ownerAuth = `Bearer ${await signUserToken(ownerId)}`;
});

const json = (auth: string, body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { authorization: auth, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function openRoom(extra: Record<string, unknown> = {}): Promise<string> {
  const res = await app.request('/api/conversations', json(ownerAuth, { projectId, ...extra }));
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
async function addPerson(id: string, userId: string) {
  const res = await app.request(`/api/conversations/${id}/people`, json(ownerAuth, { userId }));
  expect(res.status).toBe(201);
  return (await res.json()) as {
    shape: string;
    participants: Array<{ id: string; userId: string | null; kind: string }>;
  };
}
async function remove(id: string, participantId: string) {
  const res = await app.request(`/api/conversations/${id}/participants/${participantId}`, {
    method: 'DELETE',
    headers: { authorization: ownerAuth },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { shape: string };
}
async function shapeOf(id: string): Promise<string> {
  const rows = await harness.db.execute(sql`SELECT shape FROM conversations WHERE id = ${id}`);
  return (rows[0] as unknown as { shape: string }).shape;
}
async function systemLines(id: string): Promise<string[]> {
  const rows = await harness.db.execute(
    sql`SELECT content FROM conversation_messages WHERE conversation_id = ${id} AND role = 'system' ORDER BY seq`,
  );
  return (rows as unknown as Array<{ content: string }>).map((r) => r.content);
}
async function emailOf(userId: string): Promise<string> {
  const rows = await harness.db.execute(sql`SELECT email FROM users WHERE id = ${userId}`);
  return (rows[0] as unknown as { email: string }).email;
}

describe('a Forge room’s shape follows who is in it', () => {
  it('turns direct → group when a second person joins, and says who (criteria 41, 42)', async () => {
    const id = await openRoom();
    expect(await shapeOf(id)).toBe('direct');
    const after = await addPerson(id, otherId);
    expect(after.shape).toBe('group');
    expect(await shapeOf(id)).toBe('group');
    expect(await systemLines(id)).toEqual([
      `${await emailOf(otherId)} joined; this room is now a group.`,
    ]);
  });

  it('turns group → direct when the room is down to one person and one handle, and says why (criterion 43)', async () => {
    const id = await openRoom();
    const joined = await addPerson(id, otherId);
    const otherRow = joined.participants.find((p) => p.userId === otherId);
    expect(otherRow).toBeDefined();
    const after = await remove(id, otherRow?.id ?? '');
    expect(after.shape).toBe('direct');
    expect(await shapeOf(id)).toBe('direct');
    expect((await systemLines(id)).at(-1)).toBe(
      `${await emailOf(otherId)} left; this room is now a one-to-one chat.`,
    );
  });

  // cm:guard the control for the demotion: two HANDLES keep a room a group after a person leaves, so the rule is read off both counts and not off the person count alone (ISS-1034 criterion 44).
  it('stays group with two handles after a person leaves (criterion 44)', async () => {
    const second = await createTestProject(harness.db, ownerId, {
      orgId,
      slug: `beta-${randomUUID().slice(0, 8)}`,
    });
    await harness.db.execute(
      sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${second.id}, ${ownerId}, 'admin') ON CONFLICT DO NOTHING`,
    );
    // a room about two projects is read only by somebody holding a role on both, so the joiner needs one on beta too
    await harness.db.execute(
      sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${second.id}, ${otherId}, 'member') ON CONFLICT DO NOTHING`,
    );
    const id = await openRoom({ handles: [{ projectId: second.id }] });
    expect(await shapeOf(id)).toBe('group');
    const joined = await addPerson(id, otherId);
    const otherRow = joined.participants.find((p) => p.userId === otherId);
    const after = await remove(id, otherRow?.id ?? '');
    expect(after.shape).toBe('group');
    expect(await systemLines(id)).toEqual([]);
  });

  it('opens a room already holding two people as a group with nothing to explain', async () => {
    const id = await openRoom({ people: [otherId] });
    expect(await shapeOf(id)).toBe('group');
    expect(await systemLines(id)).toEqual([]);
  });

  // cm:guard the flip has to reach the READ fence the same request: a room turned back to direct is read by its live people alone, and a person just taken out of it is refused its transcript by name rather than shown it a while longer (ISS-1034 criterion 47).
  it('refuses a person no longer in a room that turned direct again (criterion 47)', async () => {
    const id = await openRoom();
    const joined = await addPerson(id, otherId);
    expect(
      (await app.request(`/api/conversations/${id}`, { headers: { authorization: otherAuth } }))
        .status,
    ).toBe(200);
    const otherRow = joined.participants.find((p) => p.userId === otherId);
    await remove(id, otherRow?.id ?? '');
    const res = await app.request(`/api/conversations/${id}`, {
      headers: { authorization: otherAuth },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_IN_THE_ROOM');
  });

  it('leaves a channel room’s shape alone when nobody is recorded as a person (criterion 45)', async () => {
    const store = await import('../../src/conversations/store.js');
    const { settleShape } = await import('../../src/conversations/membership.js');
    const room = await store.openConversation({
      adapter: 'rocketchat',
      externalId: `chat.example.co ${randomUUID()}`,
      shape: 'group',
      projectId,
    });
    expect(await settleShape(harness.db as never, room.id)).toBeNull();
    expect(await shapeOf(room.id)).toBe('group');
    void thirdId;
  });
});
