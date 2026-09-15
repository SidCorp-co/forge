/**
 * ISS-1028 — archiving a room, over the real HTTP surface and a real Postgres.
 *
 * The three propositions this file exists for, none of which the handler can
 * answer alone: an archived room leaves BOTH the page and the total rather than
 * only the page, it is still reachable by asking for it and still holds every
 * message it held, and a PATCH body carrying neither field is refused by name
 * instead of writing nothing and answering 200.
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
  // cm:edge lockstep -> packages/core/src/index.ts — the mount is `/api/conversations`; this file builds its own app, so the two can disagree about where the router sits and every URL below is absolute.
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
    await createTestProject(harness.db, ownerId, { slug: `arch-${randomUUID().slice(0, 8)}` })
  ).id;
  await createTestProjectMember(harness.db, { projectId, userId: ownerId, role: 'admin' });
});

function room(title: string) {
  return store.openConversation({
    adapter: 'rocketchat',
    externalId: `chat.example.co ${randomUUID()}`,
    shape: 'group',
    projectId,
    title,
  });
}

interface Listed {
  items: Array<{ id: string; title: string | null; archivedAt: string | null }>;
  total: number;
}

async function list(query: string): Promise<Listed> {
  const res = await app.request(`/api/conversations?projectId=${projectId}${query}`, {
    headers: await auth(ownerId),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Listed;
}

async function patch(id: string, body: unknown) {
  return app.request(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { ...(await auth(ownerId)), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('an archived room leaves the default list', () => {
  it('drops it from the items AND from the total, not from the page alone', async () => {
    const kept = await room('kept');
    const filed = await room('filed away');

    const before = await list('');
    expect(before.items.map((r) => r.id).sort()).toEqual([kept.id, filed.id].sort());
    expect(before.total).toBe(2);

    expect((await patch(filed.id, { archived: true })).status).toBe(200);

    const after = await list('');
    expect(after.items.map((r) => r.id)).toEqual([kept.id]);
    // cm:guard the total is asserted SEPARATELY from the items because it is computed separately:
    // the route counts what survived the scope filter, so a list filtered and a count that was not
    // would print one row over "2 conversations" and page somebody into an empty second page.
    expect(after.total).toBe(1);
  });

  it('lists it, and only it, when the caller asks for the archived side', async () => {
    const kept = await room('kept');
    const filed = await room('filed away');
    await patch(filed.id, { archived: true });

    const archived = await list('&archived=1');
    expect(archived.items.map((r) => r.id)).toEqual([filed.id]);
    expect(archived.items[0]?.archivedAt).not.toBeNull();
    expect(archived.total).toBe(1);
    expect(archived.items.map((r) => r.id)).not.toContain(kept.id);
  });

  it('puts it back in the default list when the archive is cleared', async () => {
    const filed = await room('filed away');
    await patch(filed.id, { archived: true });

    const res = await patch(filed.id, { archived: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).toBeNull();

    expect((await list('')).items.map((r) => r.id)).toEqual([filed.id]);
    expect((await list('&archived=1')).items).toEqual([]);
  });

  // cm:guard `archived=false` is asserted as a LIVE list rather than an archived one: with
  // `z.coerce.boolean()` in the route this case is the one that goes red, because the string
  // "false" coerces to true and the caller asking for live rooms gets the archived ones.
  it('reads archived=false as the live side and not as the archived one', async () => {
    const kept = await room('kept');
    const filed = await room('filed away');
    await patch(filed.id, { archived: true });

    expect((await list('&archived=false')).items.map((r) => r.id)).toEqual([kept.id]);
    expect((await list('&archived=0')).items.map((r) => r.id)).toEqual([kept.id]);
  });

  it('refuses a query value that is neither true nor false by name', async () => {
    const res = await app.request(`/api/conversations?projectId=${projectId}&archived=maybe`, {
      headers: await auth(ownerId),
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "archived takes '1', '0', 'true' or 'false'",
    );
  });
});

describe('archiving destroys nothing', () => {
  it('leaves every message the room held readable afterwards', async () => {
    const filed = await room('filed away');
    await store.appendMessages({
      conversationId: filed.id,
      messages: [
        { role: 'user', content: 'what is the state of the pipeline' },
        { role: 'assistant', content: 'three runs are in flight' },
      ],
    });
    const before = await store.readMessages(filed.id, 50);
    expect(before.map((m) => m.content)).toEqual([
      'what is the state of the pipeline',
      'three runs are in flight',
    ]);

    await patch(filed.id, { archived: true });

    const after = await store.readMessages(filed.id, 50);
    expect(after.map((m) => m.content)).toEqual(before.map((m) => m.content));
    const detail = await app.request(`/api/conversations/${filed.id}`, {
      headers: await auth(ownerId),
    });
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { messages: unknown[] }).messages).toHaveLength(2);
  });
});

describe('the PATCH body is refused by name rather than answered with a no-op', () => {
  it('refuses a body carrying neither title nor archived, naming what a valid one holds', async () => {
    const filed = await room('untouched');
    const res = await patch(filed.id, {});
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      'a PATCH body must carry `title` (a string or null) or `archived` (a boolean), or both',
    );
    const back = await store.getConversation(filed.id);
    expect(back?.title).toBe('untouched');
    expect(back?.archivedAt).toBeNull();
  });

  it('refuses a field the body was never allowed to carry', async () => {
    const filed = await room('untouched');
    const res = await patch(filed.id, { pinned: true });
    expect(res.status).toBe(400);
    expect(await store.getConversation(filed.id)).not.toBeNull();
  });

  it('answers with the archive stamp when a rename and an archive arrive together', async () => {
    const filed = await room('before');
    const res = await patch(filed.id, { title: 'after', archived: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string | null; archivedAt: string | null };
    // cm:guard BOTH are asserted on the one answer: the handler runs two writes, and returning the
    // rename's row would hand back `archivedAt: null` for a room it had just archived.
    expect(body.title).toBe('after');
    expect(body.archivedAt).not.toBeNull();
  });
});
