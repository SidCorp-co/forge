/**
 * ISS-1229 r28 — judge-80 had a group room open in the web when another person in it deleted it, then
 * pressed Enter: the thread read "Couldn't send. Conversation not found. Try again". Every door a person
 * meets a gone room through answered `notFound('conversation not found')`, which called the room
 * "Conversation" and carried no details. A gone room now says so in the room's own words, its id in
 * details alone; and the person door refuses an id that is no account as that, apart from a role it lacks.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };
type Refusal = { code?: string; message?: string; details?: Record<string, unknown> };

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
  const { registerConversationTransport } = await import('../../src/conversations/ports.js');
  const { webConversationPorts } = await import('../../src/assistant/conversation-adapter.js');
  registerConversationTransport(webConversationPorts);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let openerId: string;
let peerId: string;
let outsiderId: string;
let projectId: string;

async function verifiedUser(): Promise<string> {
  const id = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${id}`);
  return id;
}

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = await verifiedUser();
  openerId = await verifiedUser();
  peerId = await verifiedUser();
  outsiderId = await verifiedUser();
  const orgId = (await seedOrg(harness.db, ownerId)).id;
  for (const id of [openerId, peerId, outsiderId]) {
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${id}, 'member')`,
    );
  }
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'billing', name: 'Billing', orgId })
  ).id;
  for (const id of [openerId, peerId]) {
    await harness.db.execute(
      sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${id}, 'member')`,
    );
  }
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

/** A group room the opener and the peer share, with the project's agent in it. */
async function sharedRoom(): Promise<{ id: string; peerParticipant: string }> {
  const opened = await as(openerId, '/api/conversations', 'POST', {
    projectId,
    title: 'Standup notes, to be deleted',
    people: [peerId],
  });
  expect(opened.status, await opened.clone().text()).toBe(201);
  const { id } = (await opened.json()) as { id: string };
  const rows = await harness.db.execute<{ id: string }>(
    sql`SELECT id FROM conversation_participants WHERE conversation_id = ${id} AND user_id = ${peerId}`,
  );
  return { id, peerParticipant: String(rows[0]?.id) };
}

describe('a room that is gone', () => {
  it('says so at every door a person meets it through, its id in details alone', async () => {
    const { id, peerParticipant } = await sharedRoom();
    const deleted = await as(openerId, `/api/conversations/${id}`, 'DELETE');
    expect(deleted.status, await deleted.clone().text()).toBe(204);

    const doors: Array<[string, string, string, unknown?]> = [
      ['read', 'GET', `/api/conversations/${id}`],
      ['send', 'POST', `/api/conversations/${id}/messages`, { content: 'Are we still on?' }],
      ['rename', 'PATCH', `/api/conversations/${id}`, { title: 'Renamed' }],
      ['delete', 'DELETE', `/api/conversations/${id}`],
      ['add a person', 'POST', `/api/conversations/${id}/people`, { userId: outsiderId }],
      ['add an agent', 'POST', `/api/conversations/${id}/handles`, { projectId }],
      ['take out', 'DELETE', `/api/conversations/${id}/participants/${peerParticipant}`],
      ['candidates', 'GET', `/api/conversations/${id}/candidates`],
      ['stop', 'POST', `/api/conversations/${id}/stop`],
      [
        'upload',
        'POST',
        `/api/conversations/${id}/attachments`,
        { name: 'a.png', mime: 'image/png' },
      ],
      ['download', 'GET', `/api/conversations/${id}/attachments/${randomUUID()}/download`],
    ];
    for (const [door, method, path, body] of doors) {
      const res = await as(peerId, path, method, body);
      const refusal = (await res.json()) as Refusal;
      expect([door, res.status, refusal.code, refusal.message]).toEqual([
        door,
        404,
        'CONVERSATION_GONE',
        'This room no longer exists.',
      ]);
      expect(refusal.details?.conversationId, door).toBe(id);
    }
  });
});

describe('adding a person to a room', () => {
  it('refuses an id that is no account as that, never as a role the person lacks', async () => {
    const { id } = await sharedRoom();
    const nobody = randomUUID();
    const res = await as(openerId, `/api/conversations/${id}/people`, 'POST', { userId: nobody });
    const refusal = (await res.json()) as Refusal;
    expect(res.status).toBe(400);
    expect(refusal.code).toBe('PERSON_NOT_FOUND');
    expect(refusal.message).toMatch(/^No Forge account has the id given for the person/);
    expect(refusal.message).not.toContain(nobody);
    expect(refusal.details).toEqual({ conversationId: id, userId: nobody });
  });

  it('refuses a person with no role on its project in words about this room, the project named', async () => {
    const { id } = await sharedRoom();
    const res = await as(openerId, `/api/conversations/${id}/people`, 'POST', {
      userId: outsiderId,
    });
    const refusal = (await res.json()) as Refusal;
    expect(res.status).toBe(400);
    expect(refusal.code).toBe('PERSON_OUT_OF_SCOPE');
    expect(refusal.message).toMatch(/^This room is read only by somebody holding a role/);
    expect(refusal.message).toContain('the project Billing');
    for (const named of [id, outsiderId, projectId]) expect(refusal.message).not.toContain(named);
    expect(refusal.details).toEqual({ conversationId: id, userId: outsiderId, projectId });
  });

  it('offers the people it could take in with when each joined the organization', async () => {
    const opened = await as(openerId, '/api/conversations', 'POST', { projectId });
    const { id } = (await opened.json()) as { id: string };
    await harness.db.execute(
      sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${outsiderId}, 'member')`,
    );
    const res = await as(openerId, `/api/conversations/${id}/candidates`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { people } = (await res.json()) as { people: Array<{ userId: string; addedAt: string }> };
    const offered = people.find((p) => p.userId === outsiderId);
    expect(offered?.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

/**
 * Round 29 — judge-84 added an agent by its project alone after deleting that project and was told
 * "No project <id>, so it has no handle to address.": an id in the sentence, the room unnamed, no
 * details. The web panel, which names the agent too, was told the agent is not on its project.
 */
describe('adding the agent of a project that is gone', () => {
  it('is refused for the project, in the room words, by the project alone or with its agent named', async () => {
    const { id } = await sharedRoom();
    const orgRows = await harness.db.execute<{ org_id: string }>(
      sql`SELECT org_id FROM projects WHERE id = ${projectId}`,
    );
    const retired = (
      await createTestProject(harness.db, ownerId, {
        slug: 'retired',
        name: 'Retired',
        orgId: String(orgRows[0]?.org_id),
      })
    ).id;
    const { resolveProjectHandle } = await import('../../src/conversations/handles.js');
    const agent = await harness.db.transaction((tx) => resolveProjectHandle(tx as never, retired));
    await harness.db.execute(sql`DELETE FROM projects WHERE id = ${retired}`);

    for (const body of [{ projectId: retired }, { projectId: retired, userId: agent.userId }]) {
      const res = await as(openerId, `/api/conversations/${id}/handles`, 'POST', body);
      const refusal = (await res.json()) as Refusal;
      expect([res.status, refusal.code, refusal.message]).toEqual([
        404,
        'PROJECT_GONE',
        'The project this agent would bring into this room no longer exists, so there is no agent of it to add.',
      ]);
      expect(refusal.details).toEqual({ conversationId: id, projectId: retired });
    }
  });

  it('is refused the same way when a room is opened naming it', async () => {
    const res = await as(openerId, '/api/conversations', 'POST', {
      projectId,
      handles: [{ projectId: randomUUID() }],
    });
    const refusal = (await res.json()) as Refusal;
    expect([res.status, refusal.code]).toEqual([404, 'PROJECT_GONE']);
    expect(refusal.message).toMatch(/^The project this agent would bring into this room/);
  });
});

describe('a message appended to a room that is gone', () => {
  it('is refused as a gone room, naming no id', async () => {
    const { id } = await sharedRoom();
    await harness.db.execute(sql`DELETE FROM conversations WHERE id = ${id}`);
    const { appendMessages } = await import('../../src/conversations/store.js');
    const err = await appendMessages({
      conversationId: id,
      messages: [{ role: 'user', content: 'still there?' }],
    } as never).catch((e: unknown) => e);
    const refused = err as { status?: number; message?: string; cause?: unknown };
    expect([refused.status, refused.message]).toEqual([404, 'This room no longer exists.']);
    expect(refused.cause).toEqual({ code: 'CONVERSATION_GONE', details: { conversationId: id } });
  });
});

/**
 * Round 29, the master's ruling (5): a room another member deleted stayed in everyone else's open
 * list, and opened from it, until a 60-second re-read found it gone. The delete now tells every
 * person who could read the room, on their own socket.
 */
describe('deleting a room', () => {
  it('tells every person who could read it, the deleter included, that it is gone', async () => {
    const { id } = await sharedRoom();
    const { roomManager } = await import('../../src/ws/server.js');
    const publish = vi.spyOn(roomManager, 'publish');
    try {
      const res = await as(openerId, `/api/conversations/${id}`, 'DELETE');
      expect(res.status, await res.clone().text()).toBe(204);
      const told = publish.mock.calls
        .filter(([, envelope]) => (envelope as { event?: string }).event === 'conversation.deleted')
        .map(([room, envelope]) => [room, (envelope as { data: unknown }).data]);
      expect(told).toEqual(
        expect.arrayContaining([
          [`user:${openerId}`, { conversationId: id }],
          [`user:${peerId}`, { conversationId: id }],
        ]),
      );
      expect(told.map(([room]) => room)).not.toContain(`user:${outsiderId}`);
    } finally {
      publish.mockRestore();
    }
  });
});
