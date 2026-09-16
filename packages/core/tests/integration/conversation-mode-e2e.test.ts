/**
 * ISS-1039 — the mode a conversation is opened in, over the real HTTP surface
 * and a real Postgres.
 *
 * Every case here is about a REFUSAL, and that is why they are integration
 * tests: each one is the route reading a room's own rows before it takes a
 * message in, and a handler test with the store stubbed would be asserting
 * against the stub's idea of what the room holds.
 *
 * What is NOT here, and where it is judged instead: a successful Agent turn
 * needs a paired device to dispatch to, so criterion 11's 202 is judged by
 * `agent-sessions/conversation-agent.test.ts` on the dispatch and by the live
 * walk on the answer.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let store: typeof import('../../src/conversations/store.js');
let signUserToken: (userId: string) => Promise<string>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  ({ signUserToken } = await import('../../src/auth/jwt.js'));

  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  // cm:edge lockstep -> packages/core/src/index.ts — the mount is `/api/conversations`; this file
  // builds its own app, so the two can disagree about where the router sits and every URL is absolute.
  app.route('/api/conversations', conversationRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

const auth = async (userId: string) => ({ authorization: `Bearer ${await signUserToken(userId)}` });

let ownerId: string;
let projectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  await createTestProjectMember(harness.db, { projectId, userId: ownerId, role: 'admin' });
});

/** A `web` room this project's handle speaks in, as the route opens one. */
async function webRoom() {
  const res = await app.request('/api/conversations', {
    method: 'POST',
    headers: { ...(await auth(ownerId)), 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, title: 'a room' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; mode: string | null };
}

const send = async (id: string, body: Record<string, unknown>) =>
  app.request(`/api/conversations/${id}/messages`, {
    method: 'POST',
    headers: { ...(await auth(ownerId)), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the mode a room is opened in', () => {
  it('opens a room with no mode settled, so the composer still offers the pick', async () => {
    expect((await webRoom()).mode).toBeNull();
  });

  // cm:guard criterion 4, and this is the assertion that would go red if the refusal were widened to
  // an accepted-and-ignored: the room's own mode has to be NAMED in what comes back, because a
  // client told only "no" cannot tell which lane it is actually in.
  it('refuses a mode sent into a room that already holds a message, naming the mode it answers in', async () => {
    const created = await webRoom();
    await store.appendMessage({
      conversationId: created.id,
      role: 'user',
      content: 'already said something',
    });

    const res = await send(created.id, { content: 'and now switch lanes', mode: 'agent' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string }; message?: string };
    expect(JSON.stringify(body)).toContain('CONVERSATION_MODE_SETTLED');
    expect(JSON.stringify(body)).toContain('assistant');
  });

  // cm:guard criterion 7: a room opened before ISS-1039 has a null column AND a transcript, and it
  // answers `assistant`. The refusal above names that, rather than reporting the column as unset and
  // silently settling a mode over a conversation already under way.
  it('reads a room that held messages before the column existed as an assistant room', async () => {
    const created = await webRoom();
    await store.appendMessage({
      conversationId: created.id,
      role: 'user',
      content: 'from before the column existed',
    });
    const row = await store.getConversation(created.id);
    expect(row?.mode).toBeNull();
    expect(store.effectiveConversationMode(row as { mode: null })).toBe('assistant');
  });

  // cm:guard criteria 17 and 18 together, and they are one case because the second is what makes the
  // first worth having: the message is NOT taken in, so there is no Assistant answer standing where
  // the person asked for a box. This harness has no runner registered, which IS the condition.
  it('refuses Agent mode on a project with no paired box, and takes the message in nowhere', async () => {
    const created = await webRoom();

    const res = await send(created.id, { content: 'look at src/index.ts', mode: 'agent' });

    expect(res.status).toBe(409);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('CONVERSATION_AGENT_NO_DEVICE');
    expect(body).toContain(projectId);
    expect(await store.readMessages(created.id, 10)).toEqual([]);
    expect((await store.getConversation(created.id))?.mode).toBeNull();
  });

  // cm:guard criterion 15 and 16: the offer travels with the room and carries the reason, because
  // the browser cannot make a fleet read and a composer that guessed would grey a control out for
  // the wrong reason or offer one the send then refuses.
  it('tells the composer Agent is unavailable, and why, on a project with no box', async () => {
    const created = await webRoom();
    const res = await app.request(`/api/conversations/${created.id}`, {
      headers: await auth(ownerId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentMode: { available: boolean; reason: string | null } };
    expect(body.agentMode.available).toBe(false);
    expect(body.agentMode.reason).toContain('no box paired');
  });

  // cm:guard criteria 8 and 9: two first sends racing in one empty room. The settle is fenced on
  // `mode IS NULL` inside the transaction that commits the message, so exactly one is admitted —
  // and the loser is told which mode won rather than having its message quietly collected into the
  // other lane.
  it('admits exactly one of two first sends, and names the winner to the other', async () => {
    const created = await webRoom();
    const [a, b] = await Promise.all([
      send(created.id, { content: 'first', mode: 'assistant' }),
      send(created.id, { content: 'also first', mode: 'assistant' }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes[1]).toBe(409);
    const refused = a.status === 409 ? a : b;
    expect(JSON.stringify(await refused.json())).toContain('CONVERSATION_MODE_SETTLED');
    expect((await store.getConversation(created.id))?.mode).toBe('assistant');
  });
});
