/**
 * ISS-1236 r5 — judge-134 at dfa50c2: two sends carrying one `clientToken` were written as two
 * messages, while the web composer's Retry resends a failed message under the same token. A send whose
 * write landed and whose answer was lost was therefore written twice. A repeat of a token its sender
 * already used in the room now writes nothing and is answered with the first message.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { repeatedWebSend } from '../../src/assistant/repeated-send.js';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

vi.mock('../../src/assistant/repeated-send.js', async (real) => {
  const actual = await real<typeof import('../../src/assistant/repeated-send.js')>();
  return { ...actual, repeatedWebSend: vi.fn(actual.repeatedWebSend) };
});

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
let roomId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  memberId = (await createTestUser(harness.db)).id;
  await harness.db.execute(
    sql`UPDATE users SET email_verified_at = now() WHERE id IN (${ownerId}, ${memberId})`,
  );
  const orgId = (await seedOrg(harness.db, ownerId)).id;
  await harness.db.execute(
    sql`INSERT INTO organization_members (org_id, user_id, role) VALUES (${orgId}, ${memberId}, 'member')`,
  );
  const projectId = (
    await createTestProject(harness.db, ownerId, { slug: 'repeats', name: 'Repeats', orgId })
  ).id;
  await harness.db.execute(
    sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${projectId}, ${memberId}, 'member')`,
  );
  const opened = await as(ownerId, '/api/conversations', 'POST', {
    projectId,
    people: [memberId],
  });
  expect(opened.status, await opened.clone().text()).toBe(201);
  roomId = ((await opened.json()) as { id: string }).id;
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

async function send(userId: string, body: Record<string, unknown>): Promise<number> {
  const res = await as(userId, `/api/conversations/${roomId}/messages`, 'POST', body);
  expect(res.status, await res.clone().text()).toBeLessThan(300);
  return ((await res.json()) as { seq: number }).seq;
}

async function stored(): Promise<Array<{ seq: number; author: string; token: string | null }>> {
  return (await harness.db.execute(
    sql`SELECT seq, author_user_id AS author, client_token AS token FROM conversation_messages
         WHERE conversation_id = ${roomId} AND role = 'user' ORDER BY seq`,
  )) as unknown as Array<{ seq: number; author: string; token: string | null }>;
}

describe('a send repeating its client token', () => {
  it('writes no second message and answers with the first', async () => {
    const first = await send(ownerId, { content: 'hello', clientToken: 'tok-1' });
    const again = await send(ownerId, { content: 'hello', clientToken: 'tok-1' });
    expect(again).toBe(first);
    expect(await stored()).toEqual([{ seq: first, author: ownerId, token: 'tok-1' }]);
  });

  it('is answered even when the first send named the mode the room has since settled in', async () => {
    const first = await send(ownerId, { content: 'hi', mode: 'assistant', clientToken: 'tok-m' });
    const again = await send(ownerId, { content: 'hi', mode: 'assistant', clientToken: 'tok-m' });
    expect(again).toBe(first);
    expect(await stored()).toHaveLength(1);
  });

  it('ends as one message when the two sends arrive together', async () => {
    const [a, b] = await Promise.all([
      send(ownerId, { content: 'race', clientToken: 'tok-r' }),
      send(ownerId, { content: 'race', clientToken: 'tok-r' }),
    ]);
    expect(a).toBe(b);
    expect(await stored()).toHaveLength(1);
  });

  it('is answered when the first send lands between its lookup and its read of the room', async () => {
    const first = await send(ownerId, {
      content: 'first',
      mode: 'assistant',
      clientToken: 'tok-fm',
    });
    // The lookup this repeat makes first ran before the first send committed, so it missed.
    vi.mocked(repeatedWebSend).mockResolvedValueOnce(null);
    const again = await send(ownerId, {
      content: 'first',
      mode: 'assistant',
      clientToken: 'tok-fm',
    });
    expect(again).toBe(first);
    expect(await stored()).toHaveLength(1);
  });

  it('is answered whichever refusal past the door the late repeat meets, not only a settled mode', async () => {
    const first = await send(ownerId, { content: 'pic', clientToken: 'tok-any' });
    vi.mocked(repeatedWebSend).mockResolvedValueOnce(null);
    const again = await send(ownerId, {
      content: 'pic',
      clientToken: 'tok-any',
      attachmentIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(again).toBe(first);
    expect(await stored()).toHaveLength(1);
  });

  it("writes another person's send under the same token as that person's own message", async () => {
    await send(ownerId, { content: 'mine', clientToken: 'tok-s' });
    await send(memberId, { content: 'theirs', clientToken: 'tok-s' });
    expect((await stored()).map((m) => m.author)).toEqual([ownerId, memberId]);
  });

  it('writes every send that carries no token, and every send under a new one', async () => {
    await send(ownerId, { content: 'one' });
    await send(ownerId, { content: 'one' });
    await send(ownerId, { content: 'two', clientToken: 'tok-a' });
    await send(ownerId, { content: 'two', clientToken: 'tok-b' });
    expect(await stored()).toHaveLength(4);
  });
});
