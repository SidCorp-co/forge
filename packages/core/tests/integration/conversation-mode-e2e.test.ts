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

  it('opens a room in Assistant mode when the first send names none', async () => {
    const created = await webRoom();
    const res = await send(created.id, { content: 'no mode named' });
    expect([201, 202]).toContain(res.status);
    expect((await store.getConversation(created.id))?.mode).toBe('assistant');
  });

  it('never changes the mode after the first send, by any later send', async () => {
    const created = await webRoom();
    expect([201, 202]).toContain((await send(created.id, { content: 'first' })).status);

    const quiet = await send(created.id, { content: 'second, naming nothing' });
    expect([201, 202]).toContain(quiet.status);
    expect((await store.getConversation(created.id))?.mode).toBe('assistant');

    for (const mode of ['agent', 'assistant'] as const) {
      const res = await send(created.id, { content: 'switch lanes', mode });
      expect(res.status, mode).toBe(409);
      expect((await store.getConversation(created.id))?.mode, mode).toBe('assistant');
    }
  });

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

describe('what a room is told about a turn it handed to a box', () => {
  /** One `agent_sessions` row carrying the conversation marker, as the dispatcher writes it. */
  async function agentSession(over: {
    windowId: string;
    startedAt: string | null;
    status?: string;
    runtimeState?: string | null;
    marker?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    const runId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO pipeline_runs (id, project_id, kind, status)
      VALUES (${runId}::uuid, ${projectId}::uuid, 'interactive', 'running')`);
    await harness.db.execute(sql`
      INSERT INTO agent_sessions (id, project_id, pipeline_run_id, user_id, status, runtime_state, started_at, metadata)
      VALUES (
        ${id}::uuid, ${projectId}::uuid, ${runId}::uuid, ${ownerId}::uuid,
        ${over.status ?? 'running'}, ${over.runtimeState ?? null},
        ${over.startedAt}::timestamptz,
        ${JSON.stringify({
          conversationAgent: {
            venue: { adapter: 'web', externalId: 'v1', shape: 'direct', projectId },
            conversationId: 'set-below',
            windowId: over.windowId,
            deliveryKey: 'key-1',
            handleName: 'Forge',
            question: 'which file?',
            askedByLabel: 'Ada',
            door: 'web-agent-completion',
            replies: { dedup: 'd', noDevice: 'n', failed: 'f', ack: null },
            ackAfterMs: null,
            claimedAt: null,
            deliveredAt: null,
            failure: null,
            ...over.marker,
          },
        })}::jsonb
      )`);
    return id;
  }

  const turnsIn = async (conversationId: string) => {
    const res = await app.request(`/api/conversations/${conversationId}`, {
      headers: await auth(ownerId),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { agentTurns: Array<{ state: string; reason: string | null }> })
      .agentTurns;
  };

  const withRoom = async (
    conversationId: string,
    over: Parameters<typeof agentSession>[0],
  ): Promise<void> => {
    await agentSession({ ...over, marker: { ...over.marker, conversationId } });
  };

  it('calls a turn dispatched until a box has written a runtime state of its own', async () => {
    const created = await webRoom();
    await withRoom(created.id, { windowId: randomUUID(), startedAt: new Date().toISOString() });
    expect((await turnsIn(created.id))[0]?.state).toBe('dispatched');
  });

  it('calls it running once the runner reports one', async () => {
    const created = await webRoom();
    await withRoom(created.id, {
      windowId: randomUUID(),
      startedAt: new Date().toISOString(),
      runtimeState: 'working',
    });
    expect((await turnsIn(created.id))[0]?.state).toBe('running');
  });

  it('does not call a claimed turn delivered until the answer is stamped', async () => {
    const created = await webRoom();
    await withRoom(created.id, {
      windowId: randomUUID(),
      startedAt: new Date().toISOString(),
      status: 'completed',
      marker: { claimedAt: new Date().toISOString() },
    });
    expect((await turnsIn(created.id))[0]?.state).toBe('running');
  });

  it('calls it delivered once the answer is stamped', async () => {
    const created = await webRoom();
    await withRoom(created.id, {
      windowId: randomUUID(),
      startedAt: new Date().toISOString(),
      status: 'completed',
      marker: { claimedAt: new Date().toISOString(), deliveredAt: new Date().toISOString() },
    });
    expect((await turnsIn(created.id))[0]?.state).toBe('delivered');
  });

  it('does not read a session that was created and never dispatched as a handoff', async () => {
    const windowId = randomUUID();
    const created = await webRoom();
    await withRoom(created.id, { windowId, startedAt: null, status: 'idle' });
    const { conversationAgentTurnForWindow } = await import(
      '../../src/agent-sessions/conversation-agent.js'
    );
    expect(await conversationAgentTurnForWindow(windowId)).toBeNull();
  });

  it('reads one whose dispatch was accepted as exactly that handoff', async () => {
    const windowId = randomUUID();
    const created = await webRoom();
    const id = await agentSession({
      windowId,
      startedAt: new Date().toISOString(),
      marker: { conversationId: created.id },
    });
    const { conversationAgentTurnForWindow } = await import(
      '../../src/agent-sessions/conversation-agent.js'
    );
    expect(await conversationAgentTurnForWindow(windowId)).toEqual({ sessionId: id });
  });

  it('answers the draft composer about the project, with no room in hand', async () => {
    const res = await app.request(`/api/conversations/agent-mode?projectId=${projectId}`, {
      headers: await auth(ownerId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason: string | null };
    expect(body.available).toBe(false);
    expect(body.reason).toContain('no box paired');
  });

  it('refuses that door to somebody with no role on the project', async () => {
    const stranger = (await createTestUser(harness.db)).id;
    const res = await app.request(`/api/conversations/agent-mode?projectId=${projectId}`, {
      headers: await auth(stranger),
    });
    expect(res.status).toBe(403);
  });
});
