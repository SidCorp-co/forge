/**
 * ISS-1011 — what an agent added to a live room is actually shown.
 *
 * The agent-addition confirmation tells a person that the agent will be shown
 * what has already been said in the room, and that it reads the recent part of
 * it rather than the whole. Both halves are claims about code, and neither can
 * be judged from the confirmation: they are judged here, at the only place the
 * product makes them — the message array the chat provider is handed on a real
 * send through `POST /api/conversations/:id/messages`.
 *
 * A join-time cut added anywhere in that chain turns the first sentence into a
 * lie and this file red. A wider provider window turns the second into one and
 * turns it red the same way.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatStreamEvent } from '../../src/assistant/providers/types.js';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/** Every message array the provider was handed, newest call last. */
const handed: ChatMessage[][] = [];

// cm:guard the PROVIDER is stubbed and nothing else is: the store is real Postgres, the route is the real route, the collector and the window are the real ones. What a model would have answered is the only thing this test has no use for, and what it was ASKED is the whole subject.
vi.mock('../../src/assistant/providers/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assistant/providers/registry.js')>();
  return {
    ...actual,
    resolveForProject: async () => ({
      model: 'recording',
      provider: {
        id: 'recording',
        defaultModel: 'recording',
        async *stream(req: { messages: ChatMessage[] }): AsyncIterable<ChatStreamEvent> {
          handed.push(req.messages);
          yield { type: 'chunk', text: 'noted' };
          yield { type: 'done' };
        },
      },
    }),
  };
});

let harness: TestDatabase;
let app: Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>;
let ownerId: string;
let orgId: string;
let projectA: string;
let ownerAuth: string;

const JWT_SECRET = 'test-secret-at-least-32-chars-long-abcdef-123456';

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';

  const { conversationRoutes } = await import('../../src/assistant/conversation-routes.js');
  const { webConversationPorts } = await import('../../src/assistant/conversation-adapter.js');
  const { registerConversationTransport } = await import('../../src/conversations/ports.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  registerConversationTransport(webConversationPorts);

  app = new Hono<{ Variables: import('../../src/middleware/request-id.js').RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/conversations', conversationRoutes);
  app.onError(errorHandler);
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  handed.length = 0;
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now(), display_name = 'Ada'`);
  orgId = (await seedOrg(harness.db, ownerId)).id;
  projectA = (
    await createTestProject(harness.db, ownerId, {
      orgId,
      slug: `alpha-${randomUUID().slice(0, 8)}`,
    })
  ).id;
  const { signUserToken } = await import('../../src/auth/jwt.js');
  ownerAuth = `Bearer ${await signUserToken(ownerId)}`;
});

const json = { 'content-type': 'application/json' };

async function openRoom(): Promise<string> {
  const res = await app.request('/api/conversations', {
    method: 'POST',
    headers: { authorization: ownerAuth, ...json },
    body: JSON.stringify({ projectId: projectA }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function say(id: string, content: string): Promise<void> {
  const res = await app.request(`/api/conversations/${id}/messages`, {
    method: 'POST',
    headers: { authorization: ownerAuth, ...json },
    body: JSON.stringify({ content }),
  });
  expect(res.status).toBe(201);
}

/**
 * A SECOND agent on the same project, so a room can gain one without widening.
 */
// cm:guard the same project deliberately: an agent from a second project makes the room span two, and a web send into such a room is refused by name — which is a different criterion with its own case. Proving the pre-join claim through a refused send would prove nothing at all.
async function secondAgentOn(projectId: string): Promise<string> {
  const { db } = await import('../../src/db/client.js');
  const handle = `second-${randomUUID().slice(0, 8)}`;
  const [row] = await db.execute(
    sql`INSERT INTO users (email, kind, password_hash, email_verified_at)
        VALUES (${`${handle}@agents.forge.local`}, 'agent', NULL, now()) RETURNING id`,
  );
  const userId = (row as { id: string }).id;
  await db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role, handle)
        VALUES (${orgId}, ${userId}, 'member', ${handle})`,
  );
  await db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role)
        VALUES (${projectId}, ${userId}, 'member') ON CONFLICT DO NOTHING`,
  );
  return userId;
}

async function addAgent(id: string, userId: string, projectId: string): Promise<Response> {
  return app.request(`/api/conversations/${id}/handles`, {
    method: 'POST',
    headers: { authorization: ownerAuth, ...json },
    body: JSON.stringify({ userId, projectId }),
  });
}

const handedText = (): string =>
  (handed.at(-1) ?? []).map((m) => JSON.stringify(m.content)).join('\n');

describe('an agent added to a live room', () => {
  it('is shown what was said in the room before it joined', async () => {
    const id = await openRoom();
    await say(id, 'the pipeline wedged on Tuesday and nobody noticed');

    const joined = await addAgent(id, await secondAgentOn(projectA), projectA);
    expect(joined.status).toBe(201);
    expect(((await joined.json()) as { scope: string[] }).scope).toEqual([projectA]);

    handed.length = 0;
    await say(id, 'what do you make of that?');

    // cm:guard the assertion is on the LINE said before the agent joined, and not on a message count: a join-time cut that kept the count and dropped the content would pass a length test.
    expect(handedText()).toContain('the pipeline wedged on Tuesday and nobody noticed');
  });

  it('is shown the whole of a short room, oldest line included', async () => {
    const id = await openRoom();
    await say(id, 'a first thing, said before anybody else was here');
    expect(await addAgent(id, await secondAgentOn(projectA), projectA)).toHaveProperty(
      'status',
      201,
    );
    handed.length = 0;
    await say(id, 'and a second thing, said after');
    expect(handedText()).toContain('a first thing, said before anybody else was here');
    expect(handedText()).toContain('and a second thing, said after');
  });

  it('is not shown the part of the room older than the provider window', async () => {
    const { PROVIDER_HISTORY_WINDOW } = await import('../../src/assistant/context-budget.js');
    const { appendMessages } = await import('../../src/conversations/store.js');
    const id = await openRoom();

    // cm:guard the filler is written as ROWS rather than sent, because what bounds the model's view is the window over the stored room and not the number of turns taken in it — and 30 real sends to prove a slice is 30 turns paid for one assertion.
    await appendMessages({
      conversationId: id,
      messages: [
        { role: 'user', content: 'the oldest thing anybody said in this room' },
        ...Array.from({ length: PROVIDER_HISTORY_WINDOW + 4 }, (_, i) => ({
          role: 'user' as const,
          content: `filler ${i}`,
        })),
      ],
    });

    handed.length = 0;
    await say(id, 'and now a question');
    const last = handed.at(-1) ?? [];
    expect(handedText()).not.toContain('the oldest thing anybody said in this room');
    expect(handedText()).toContain('and now a question');
    // cm:guard one over the window is the system prompt, which is not history.
    expect(last.length).toBeLessThanOrEqual(PROVIDER_HISTORY_WINDOW + 1);
  });
});
