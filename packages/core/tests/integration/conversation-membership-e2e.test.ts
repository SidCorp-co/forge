/**
 * ISS-1011 — changing who is in a room, over the real router and real Postgres.
 *
 * Every rule here is a JOIN across participants, project memberships and the
 * derived scope, and every mock of one of those answers whatever the mock was
 * told. So the refusals are asserted by their own codes against real rows: who
 * may add an agent, who may be added as a person, what the scope becomes on
 * either side of a change, and the two members a room may not lose.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let orgId: string;
let projectA: string;
let projectB: string;
let owner: string;
let colleague: string;
let outsider: string;
let viewer: string;
let ownerAuth: string;
let viewerAuth: string;
let outsiderAuth: string;

const JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';
const json = { 'content-type': 'application/json' };

interface Membership {
  shape: string;
  scope: string[];
  scopeProjects: Array<{ id: string; name: string; slug: string }>;
  participants: Array<{
    id: string;
    kind: string;
    userId: string | null;
    projectId: string | null;
    displayName: string | null;
  }>;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/conversations', conversationRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const member = async (projectId: string, userId: string, role: string) =>
  harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${userId}, ${role})
        ON CONFLICT (project_id, user_id) DO UPDATE SET role = ${role}`,
  );

const inOrg = async (userId: string) =>
  harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${userId}, 'member')
        ON CONFLICT DO NOTHING`,
  );

beforeEach(async () => {
  await truncateAll(harness.db);
  owner = (await createTestUser(harness.db)).id;
  colleague = (await createTestUser(harness.db)).id;
  outsider = (await createTestUser(harness.db)).id;
  viewer = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  await harness.db.execute(sql`UPDATE users SET display_name = 'Ada' WHERE id = ${owner}`);
  await harness.db.execute(sql`UPDATE users SET display_name = 'Grace' WHERE id = ${colleague}`);

  orgId = (await seedOrg(harness.db, owner)).id;
  for (const u of [colleague, outsider, viewer]) await inOrg(u);
  projectA = (
    await createTestProject(harness.db, owner, { orgId, slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  projectB = (
    await createTestProject(harness.db, owner, { orgId, slug: `beta-${randomUUID().slice(0, 8)}` })
  ).id;
  for (const p of [projectA, projectB]) await member(p, owner, 'admin');
  await member(projectA, colleague, 'member');
  await member(projectA, viewer, 'viewer');

  const { signUserToken } = await import('../../src/auth/jwt.js');
  ownerAuth = `Bearer ${await signUserToken(owner)}`;
  viewerAuth = `Bearer ${await signUserToken(viewer)}`;
  outsiderAuth = `Bearer ${await signUserToken(outsider)}`;
});

async function agentOf(projectId: string): Promise<string> {
  const { resolveProjectHandle } = await import('../../src/conversations/handles.js');
  const { db } = await import('../../src/db/client.js');
  return (await db.transaction((tx) => resolveProjectHandle(tx, projectId))).userId;
}

async function openRoom(body: Record<string, unknown> = {}): Promise<Membership & { id: string }> {
  const res = await app.request('/api/conversations', {
    method: 'POST',
    headers: { authorization: ownerAuth, ...json },
    body: JSON.stringify({ projectId: projectA, ...body }),
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return { id, ...(await read(id)) };
}

async function read(id: string, auth = ownerAuth): Promise<Membership> {
  const res = await app.request(`/api/conversations/${id}`, { headers: { authorization: auth } });
  expect(res.status).toBe(200);
  return (await res.json()) as Membership;
}

const addPerson = (id: string, userId: string, auth = ownerAuth) =>
  app.request(`/api/conversations/${id}/people`, {
    method: 'POST',
    headers: { authorization: auth, ...json },
    body: JSON.stringify({ userId }),
  });

const addHandle = (id: string, userId: string | undefined, projectId: string, auth = ownerAuth) =>
  app.request(`/api/conversations/${id}/handles`, {
    method: 'POST',
    headers: { authorization: auth, ...json },
    body: JSON.stringify(userId ? { userId, projectId } : { projectId }),
  });

const drop = (id: string, participantId: string, auth = ownerAuth) =>
  app.request(`/api/conversations/${id}/participants/${participantId}`, {
    method: 'DELETE',
    headers: { authorization: auth },
  });

const codeOf = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = (await res.json()) as { code?: string; error?: { code?: string }; message?: string };
  return {
    code: body.code ?? body.error?.code ?? '',
    message: JSON.stringify(body),
  };
};

describe('a room lists who is in it', () => {
  it('names each member and the project each agent brings', async () => {
    const room = await openRoom();
    const agents = room.participants.filter((p) => p.kind === 'handle');
    const people = room.participants.filter((p) => p.kind === 'person');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.projectId).toBe(projectA);
    expect(people[0]?.displayName).toBe('Ada');
    expect(room.scopeProjects.map((p) => p.id)).toEqual([projectA]);
    expect(room.scopeProjects[0]?.name).toEqual(expect.any(String));
  });
});

describe('adding a person', () => {
  it('admits a colleague who holds a role on every project the room is about', async () => {
    const room = await openRoom();
    const res = await addPerson(room.id, colleague);
    expect(res.status).toBe(201);
    const after = (await res.json()) as Membership;
    expect(after.participants.filter((p) => p.kind === 'person').map((p) => p.userId)).toContain(
      colleague,
    );
  });

  it('refuses somebody who holds no role on one of them, and names that project', async () => {
    const room = await openRoom();
    const res = await addPerson(room.id, outsider);
    expect(res.status).toBe(400);
    const { code, message } = await codeOf(res);
    expect(code).toBe('PERSON_OUT_OF_SCOPE');
    expect(message).toContain('holds no role on');
  });
});

describe('adding an agent', () => {
  it('widens the room to the project that agent brings', async () => {
    const room = await openRoom();
    const res = await addHandle(room.id, await agentOf(projectB), projectB);
    expect(res.status).toBe(201);
    const after = (await res.json()) as Membership;
    expect(after.scope.sort()).toEqual([projectA, projectB].sort());
    expect(after.shape).toBe('group');
    expect(after.scopeProjects).toHaveLength(2);
  });

  it('refuses an actor holding less than a member role on that project, and names it', async () => {
    const room = await openRoom();
    expect((await addPerson(room.id, colleague)).status).toBe(201);
    await member(projectB, colleague, 'viewer');
    const { signUserToken } = await import('../../src/auth/jwt.js');
    const colleagueAuth = `Bearer ${await signUserToken(colleague)}`;
    const res = await addHandle(room.id, await agentOf(projectB), projectB, colleagueAuth);
    expect(res.status).toBe(403);
    const { code, message } = await codeOf(res);
    expect(code).toBe('HANDLE_PROJECT_FORBIDDEN');
    expect(message).toContain(projectB);
    expect(message).toContain('viewer');
  });

  it('brings in a project whose agent has never been minted', async () => {
    const room = await openRoom();
    const res = await addHandle(room.id, undefined, projectB);
    expect(res.status).toBe(201);
    const after = (await res.json()) as Membership;
    expect(after.scope.sort()).toEqual([projectA, projectB].sort());
  });

  it('refuses an agent that is not a member of the project it is named for', async () => {
    const room = await openRoom();
    const res = await addHandle(room.id, await agentOf(projectB), projectA);
    expect(res.status).toBe(400);
    const { code, message } = await codeOf(res);
    expect(code).toBe('HANDLE_NOT_ON_PROJECT');
    expect(message).toContain('is a member of');
  });
});

describe('taking a member out', () => {
  it('narrows the room to the projects of the agents still in it', async () => {
    const room = await openRoom();
    const added = (await (
      await addHandle(room.id, await agentOf(projectB), projectB)
    ).json()) as Membership;
    const second = added.participants.find((p) => p.projectId === projectB);
    const after = (await (await drop(room.id, second?.id as string)).json()) as Membership;
    expect(after.scope).toEqual([projectA]);
  });

  it('refuses the last agent, and says what to do instead', async () => {
    const room = await openRoom();
    const only = room.participants.find((p) => p.kind === 'handle');
    const res = await drop(room.id, only?.id as string);
    expect(res.status).toBe(400);
    const { code, message } = await codeOf(res);
    expect(code).toBe('CONVERSATION_LAST_HANDLE');
    expect(message).toContain('delete the conversation');
  });

  it('refuses the last person of a one-to-one room, and says what to do instead', async () => {
    const room = await openRoom();
    const only = room.participants.find((p) => p.kind === 'person');
    const res = await drop(room.id, only?.id as string);
    expect(res.status).toBe(400);
    const { code, message } = await codeOf(res);
    expect(code).toBe('CONVERSATION_LAST_PERSON');
    expect(message).toContain('delete the conversation');
  });

  it('leaves everything that member already said in the room', async () => {
    const room = await openRoom();
    await addPerson(room.id, colleague);
    const { appendMessages } = await import('../../src/conversations/store.js');
    await appendMessages({
      conversationId: room.id,
      messages: [{ role: 'user', content: 'said while I was here', authorUserId: colleague }],
    });
    const theirs = (await read(room.id)).participants.find((p) => p.userId === colleague);
    expect((await drop(room.id, theirs?.id as string)).status).toBe(200);
    const after = await app.request(`/api/conversations/${room.id}`, {
      headers: { authorization: ownerAuth },
    });
    const body = (await after.json()) as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toContain('said while I was here');
  });
});

describe('who may change a membership at all', () => {
  it('refuses a caller who is not in the room, even on a group room its scope reaches', async () => {
    const room = await openRoom();
    await addHandle(room.id, await agentOf(projectB), projectB);
    await member(projectA, outsider, 'member');
    await member(projectB, outsider, 'member');
    expect((await read(room.id, outsiderAuth)).shape).toBe('group');
    const res = await addPerson(room.id, colleague, outsiderAuth);
    expect(res.status).toBe(403);
    expect((await codeOf(res)).code).toBe('NOT_IN_THE_ROOM');
  });

  it('refuses a caller in the room who holds less than a member role on one of its projects', async () => {
    const room = await openRoom();
    expect((await addPerson(room.id, viewer)).status).toBe(201);
    const res = await addPerson(room.id, colleague, viewerAuth);
    expect(res.status).toBe(403);
    expect((await codeOf(res)).code).toBe('CONVERSATION_OUT_OF_SCOPE');
  });
});

describe('starting a room', () => {
  it('opens one already holding the opener, a colleague and a second agent', async () => {
    await member(projectB, colleague, 'member');
    const room = await openRoom({
      people: [colleague],
      handles: [{ userId: await agentOf(projectB), projectId: projectB }],
    });
    const people = room.participants.filter((p) => p.kind === 'person').map((p) => p.userId);
    const agents = room.participants.filter((p) => p.kind === 'handle').map((p) => p.projectId);
    expect(people.sort()).toEqual([owner, colleague].sort());
    expect(agents.sort()).toEqual([projectA, projectB].sort());
    expect(room.shape).toBe('group');
    const detail = await app.request(`/api/conversations/${room.id}`, {
      headers: { authorization: ownerAuth },
    });
    expect(((await detail.json()) as { messages: unknown[] }).messages).toEqual([]);
  });

  it('refuses before opening anything when a named person cannot reach the projected scope', async () => {
    const before = await app.request(
      `/api/conversations?${new URLSearchParams({ projectId: projectA, page: '1', pageSize: '50' })}`,
      { headers: { authorization: ownerAuth } },
    );
    const count = ((await before.json()) as { total: number }).total;
    const res = await app.request('/api/conversations', {
      method: 'POST',
      headers: { authorization: ownerAuth, ...json },
      body: JSON.stringify({ projectId: projectA, people: [outsider] }),
    });
    expect(res.status).toBe(400);
    expect((await codeOf(res)).code).toBe('PERSON_OUT_OF_SCOPE');
    const after = await app.request(
      `/api/conversations?${new URLSearchParams({ projectId: projectA, page: '1', pageSize: '50' })}`,
      { headers: { authorization: ownerAuth } },
    );
    expect(((await after.json()) as { total: number }).total).toBe(count);
  });
});

describe('who a room could still take in', () => {
  it('offers the colleague and no agent already in the room', async () => {
    const room = await openRoom();
    const res = await app.request(`/api/conversations/${room.id}/candidates`, {
      headers: { authorization: ownerAuth },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      people: Array<{ userId: string }>;
      handles: Array<{ userId: string | null; handle: string; project: { id: string } }>;
    };
    expect(body.people.map((p) => p.userId)).toContain(colleague);
    expect(body.people.map((p) => p.userId)).not.toContain(owner);
    expect(body.handles.map((h) => h.project.id)).toContain(projectB);
    expect(body.handles.find((h) => h.project.id === projectB)?.userId).toBeNull();
    expect(body.handles.map((h) => h.userId)).not.toContain(await agentOf(projectA));
  });

  it('does not offer the agent of the project the room will open with', async () => {
    const minted = await agentOf(projectA);
    const res = await app.request(
      `/api/conversations/candidates?${new URLSearchParams({ projectId: projectA })}`,
      { headers: { authorization: ownerAuth } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      handles: Array<{ userId: string | null; project: { id: string } }>;
    };
    expect(body.handles.map((h) => h.userId)).not.toContain(minted);
    expect(body.handles.map((h) => h.project.id)).toContain(projectB);
  });

  it('still offers a SECOND agent of that project, which the room will not already hold', async () => {
    const opening = await agentOf(projectA);
    const other = randomUUID();
    await harness.db.execute(
      sql`INSERT INTO users (id, email, kind, password_hash, email_verified_at, created_at)
          VALUES (${other}, ${`alpha-two-${other}@agents.forge.local`}, 'agent', NULL, now(), now() + interval '1 hour')`,
    );
    await harness.db.execute(
      sql`INSERT INTO organization_members (org_id, user_id, role, handle)
          VALUES (${orgId}, ${other}, 'member', ${`alpha-two-${other.slice(0, 8)}`})`,
    );
    await member(projectA, other, 'member');

    const res = await app.request(
      `/api/conversations/candidates?${new URLSearchParams({ projectId: projectA })}`,
      { headers: { authorization: ownerAuth } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { handles: Array<{ userId: string | null }> };
    expect(body.handles.map((h) => h.userId)).toContain(other);
    expect(body.handles.map((h) => h.userId)).not.toContain(opening);
  });

  it('answers for a project before any room exists', async () => {
    const res = await app.request(
      `/api/conversations/candidates?${new URLSearchParams({ projectId: projectA })}`,
      { headers: { authorization: ownerAuth } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { people: Array<{ userId: string }>; handles: unknown[] };
    expect(body.people.map((p) => p.userId)).toContain(colleague);
  });
});

/**
 * Adding an agent can put somebody who is already in the room outside it: the
 * read rule takes a role on EVERY project a room is about, so a second project
 * silently costs anybody who holds none on it. Nothing said so before the add.
 */
describe('an agent that would cost the room a reader', () => {
  it('names the person who would lose it, on the candidate that would do it', async () => {
    const room = await openRoom();
    expect((await addPerson(room.id, colleague)).status).toBe(201);

    const res = await app.request(`/api/conversations/${room.id}/candidates`, {
      headers: { authorization: ownerAuth },
    });
    const body = (await res.json()) as {
      handles: Array<{ project: { id: string }; losesReaders: string[] }>;
    };
    const beta = body.handles.find((h) => h.project.id === projectB);
    expect(beta?.losesReaders).toEqual(['Grace']);
  });

  it('says nobody loses a room over a project it is already about', async () => {
    const room = await openRoom({ handles: [{ projectId: projectB }] });
    const res = await app.request(`/api/conversations/${room.id}/candidates`, {
      headers: { authorization: ownerAuth },
    });
    const body = (await res.json()) as {
      handles: Array<{ project: { id: string }; losesReaders: string[] }>;
    };
    for (const handle of body.handles.filter((h) => h.project.id === projectB)) {
      expect(handle.losesReaders).toEqual([]);
    }
  });

  it('is a prediction the read rule then keeps: the named person really loses the room', async () => {
    const room = await openRoom();
    expect((await addPerson(room.id, colleague)).status).toBe(201);
    const colleagueAuth = `Bearer ${await (await import('../../src/auth/jwt.js')).signUserToken(colleague)}`;

    const before = await app.request(`/api/conversations/${room.id}`, {
      headers: { authorization: colleagueAuth },
    });
    expect(before.status).toBe(200);

    expect((await addHandle(room.id, undefined, projectB)).status).toBe(201);

    const after = await app.request(`/api/conversations/${room.id}`, {
      headers: { authorization: colleagueAuth },
    });
    expect(after.status).toBe(403);
    expect((await codeOf(after)).code).toBe('CONVERSATION_OUT_OF_SCOPE');
  });
});
