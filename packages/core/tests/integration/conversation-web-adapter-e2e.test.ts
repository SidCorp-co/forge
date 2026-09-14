/**
 * ISS-1004 step 5 — the Forge UI as the second adapter, against real Postgres.
 *
 * Three things only rows can answer. That a typed message becomes a
 * `conversation_messages` row and a `conversation_windows` row under one commit
 * and that the window closes carrying a decision — which is the difference
 * criterion 28 is about, and it is a column rather than a rendering. That a
 * one-to-one room is refused to somebody who is not in it — the unit lane cannot
 * see this, because the refusal is a JOIN over participants and every mock of it
 * answers whatever the mock was told. And that a second adapter costs the store
 * one `registerConversationTransport` call, which is proved by this file
 * registering one and nothing else.
 */

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

// cm:guard ONE harness for the whole file — `db/client.ts` binds to DATABASE_URL at import time, so a second setup puts the fixtures on one database and the code under test on another.
let harness: TestDatabase;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let ownerId: string;
let otherId: string;
let projectId: string;
let ownerAuth: string;
let otherAuth: string;

interface MessageRow {
  seq: number;
  role: string;
  authorLabel: string | null;
  content: string;
  silenceReason: string | null;
  deliveryProof: unknown;
}
interface WindowRow {
  id: string;
  firstSeq: number;
  lastSeq: number;
  decision: string | null;
  closedAt: string | null;
}
interface ConversationRead {
  id: string;
  adapter: string;
  shape: string;
  scope: string[];
  messages: MessageRow[];
  windows: WindowRow[];
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { webConversationPorts } = await import('../../src/assistant/conversation-adapter.js');
  const { registerConversationTransport, registeredConversationAdapters } = await import(
    '../../src/conversations/ports.js'
  );
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');

  // cm:guard the WHOLE of what a second adapter costs the store, and this line is the measurement ISS-1002 asked for: no store module is touched, no migration runs, and `registeredConversationAdapters()` gains a name.
  expect(registeredConversationAdapters()).not.toContain('web');
  registerConversationTransport(webConversationPorts);
  expect(registeredConversationAdapters()).toContain('web');

  app = new Hono<{
    Variables: import('../../src/middleware/request-id.js').RequestIdVars;
  }>();
  app.use('*', requestId());
  app.route('/api/conversations', conversationRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  otherId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now(), display_name = 'Ada'`);
  const org = await seedOrg(harness.db, ownerId);
  await createTestOrgMember(harness.db, { orgId: org.id, userId: otherId });
  projectId = (
    await createTestProject(harness.db, ownerId, {
      orgId: org.id,
      slug: `alpha-${randomUUID().slice(0, 8)}`,
    })
  ).id;
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${otherId}, 'member')
        ON CONFLICT DO NOTHING`,
  );
  const { signUserToken } = await import('../../src/auth/jwt.js');
  ownerAuth = `Bearer ${await signUserToken(ownerId)}`;
  otherAuth = `Bearer ${await signUserToken(otherId)}`;
});

async function openRoom(): Promise<string> {
  const res = await app.request('/api/conversations', {
    method: 'POST',
    headers: { authorization: ownerAuth, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, title: 'a room of one’s own' }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function readRoom(id: string, auth = ownerAuth): Promise<Response> {
  return app.request(`/api/conversations/${id}`, { headers: { authorization: auth } });
}

async function say(id: string, content: string, auth = ownerAuth): Promise<Response> {
  return app.request(`/api/conversations/${id}/messages`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

describe('the Forge UI conversation · what a send leaves behind', () => {
  it('opens a web room the person is a participant of', async () => {
    const id = await openRoom();
    const read = (await (await readRoom(id)).json()) as ConversationRead;
    expect(read.adapter).toBe('web');
    expect(read.shape).toBe('direct');
    expect(read.scope).toEqual([projectId]);
    expect(read.messages).toEqual([]);
    expect(read.windows).toEqual([]);
  });

  it('turns a typed message into a row, a window and a decision', async () => {
    const id = await openRoom();
    const res = await say(id, 'what is left on this project?');
    expect(res.status).toBe(201);
    const body = (await res.json()) as ConversationRead & { seq: number; decision: string | null };

    const asked = body.messages.find((m) => m.role === 'user');
    expect(asked).toMatchObject({
      seq: 0,
      content: 'what is left on this project?',
      authorLabel: 'Ada',
    });

    // cm:guard the window is the unit a decision was taken over, and it must be CLOSED carrying one: an open window here would mean the send returned before anything decided, which is the 202 shape this route exists not to be.
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0]).toMatchObject({ firstSeq: 0, lastSeq: 0 });
    expect(body.windows[0]?.closedAt).toEqual(expect.any(String));
    expect(body.windows[0]?.decision).toEqual(expect.any(String));
    expect(body.decision).toBe(body.windows[0]?.decision);
    // cm:guard `unreachable` is what this module writes when it knows BEFORE anything was sent that it cannot answer — no conversation, no readable message, no transport. A reachable room reaching it means a guard threw, which is exactly the defect this file found: `recentDecisions` bound its `since` into a raw `sql` fragment, `postgres` refused the Date, and every routed window closed `unreachable` over a room nobody had asked (ISS-1004 rule 4).
    expect(body.windows[0]?.decision).not.toBe('unreachable');
  });

  // cm:guard the same defect at its own seam rather than only through the route above: a guard that throws is swallowed by `routeWindow`'s catch, so the only thing a route-level assertion can see is the decision that came out. This one fails where the fault is.
  it('reads the decisions settled since an anchor, with a real Date', async () => {
    const id = await openRoom();
    await say(id, 'hello');
    const windows = await import('../../src/conversations/windows.js');
    const since = new Date(Date.now() - 60_000);
    await expect(windows.recentDecisions(id, { since, limit: 8 })).resolves.toHaveLength(1);
  });

  // cm:guard this is criterion 28 as a row rather than as a rendering: a turn that SAID NOTHING leaves a decision naming why, and a turn that was NEVER TAKEN leaves no window at all — so the two are told apart by what is present, not by reading a message's text.
  it('tells a turn that was never taken from one that said nothing', async () => {
    const id = await openRoom();
    const before = (await (await readRoom(id)).json()) as ConversationRead;
    expect(before.windows).toEqual([]);

    await say(id, 'hello');
    const after = (await (await readRoom(id)).json()) as ConversationRead;
    expect(after.windows).toHaveLength(1);
    expect(after.windows[0]?.decision).not.toBeNull();
  });

  it('keeps the question when a second message opens its own window', async () => {
    const id = await openRoom();
    await say(id, 'first');
    await say(id, 'second');
    const read = (await (await readRoom(id)).json()) as ConversationRead;
    const asked = read.messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(asked).toEqual(['first', 'second']);
    expect(read.windows).toHaveLength(2);
    expect(read.windows.map((w) => w.firstSeq)).toEqual(
      [...read.windows.map((w) => w.firstSeq)].sort((a, b) => a - b),
    );
  });
});

describe('the Forge UI conversation · who may read a one-to-one room', () => {
  it('refuses a project member who is not in the room, by name', async () => {
    const id = await openRoom();
    const res = await readRoom(id, otherAuth);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_IN_THE_ROOM');
  });

  it('keeps it out of that member’s list as well as out of their reads', async () => {
    const id = await openRoom();
    const mine = await app.request(`/api/conversations?projectId=${projectId}`, {
      headers: { authorization: ownerAuth },
    });
    expect(
      ((await mine.json()) as { items: Array<{ id: string }> }).items.map((r) => r.id),
    ).toEqual([id]);

    const theirs = await app.request(`/api/conversations?projectId=${projectId}`, {
      headers: { authorization: otherAuth },
    });
    expect(((await theirs.json()) as { items: Array<{ id: string }> }).items).toEqual([]);
  });

  it('refuses their send too', async () => {
    const id = await openRoom();
    const res = await say(id, 'let me in', otherAuth);
    expect(res.status).toBe(403);
  });
});
