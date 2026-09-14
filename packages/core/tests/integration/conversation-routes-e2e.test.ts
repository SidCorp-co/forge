/**
 * ISS-1001 — `/api/conversations` over the real HTTP surface and a real
 * Postgres, because what it answers is an authorization question and a
 * pagination question, and neither can be judged from the handler alone.
 *
 * The two cases that are the point: a viewer may look at a room and may not
 * rename or delete it, and a page is cut from what the caller may SEE rather
 * than from what the project holds — a room they cannot read, sorted ahead of
 * one they can, used to eat their whole first page and be counted in the total.
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
let participants: typeof import('../../src/conversations/participants.js');
let handles: typeof import('../../src/conversations/handles.js');
let signUserToken: (userId: string) => Promise<string>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  participants = await import('../../src/conversations/participants.js');
  handles = await import('../../src/conversations/handles.js');
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
let projectA: string;
let projectB: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db)).id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectA = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  projectB = (
    await createTestProject(harness.db, ownerId, { slug: `beta-${randomUUID().slice(0, 8)}` })
  ).id;
});

async function member(projectId: string, role: 'viewer' | 'member' | 'admin') {
  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  await createTestProjectMember(harness.db, { projectId, userId: user.id, role });
  return user.id;
}

function room(projectId: string, externalId = `chat.example.co ${randomUUID()}`) {
  return store.openConversation({
    adapter: 'rocketchat',
    externalId,
    shape: 'group',
    projectId,
    title: externalId,
  });
}

describe('a viewer may look at a room and not change it', () => {
  it('lets a viewer read one', async () => {
    const created = await room(projectA);
    const viewer = await member(projectA, 'viewer');
    const res = await app.request(`/api/conversations/${created.id}`, {
      headers: await auth(viewer),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string[] }).scope).toEqual([projectA]);
  });

  it('refuses a viewer renaming one', async () => {
    const created = await room(projectA);
    const viewer = await member(projectA, 'viewer');
    const res = await app.request(`/api/conversations/${created.id}`, {
      method: 'PATCH',
      headers: { ...(await auth(viewer)), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed by a viewer' }),
    });
    expect(res.status).toBe(403);
    const back = await store.getConversation(created.id);
    expect(back?.title).toBe(created.title);
  });

  it('refuses a viewer deleting one', async () => {
    const created = await room(projectA);
    const viewer = await member(projectA, 'viewer');
    const res = await app.request(`/api/conversations/${created.id}`, {
      method: 'DELETE',
      headers: await auth(viewer),
    });
    expect(res.status).toBe(403);
    expect(await store.getConversation(created.id)).not.toBeNull();
  });

  it('lets a member rename and delete one', async () => {
    const created = await room(projectA);
    const who = await member(projectA, 'member');
    const patched = await app.request(`/api/conversations/${created.id}`, {
      method: 'PATCH',
      headers: { ...(await auth(who)), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed' }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { title: string }).title).toBe('renamed');

    const deleted = await app.request(`/api/conversations/${created.id}`, {
      method: 'DELETE',
      headers: await auth(who),
    });
    expect(deleted.status).toBe(204);
    expect(await store.getConversation(created.id)).toBeNull();
  });
});

describe('the page is cut from what the caller may see', () => {
  // cm:guard the hidden room sorts FIRST and the page size is one: filter after paginating and this caller gets an empty page, never reaches the room they can read, and is told there are two.
  it('skips a room the caller cannot read instead of spending their page on it', async () => {
    const readable = await room(projectA);
    const shared = await room(projectA);
    const otherHandle = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectB),
    );
    await participants.addHandle({
      conversationId: shared.id,
      handleUserId: otherHandle.userId,
      projectId: projectB,
      actorUserId: ownerId,
    });
    // cm:why the shared room is renamed last, so it sorts ahead of the one this caller may read
    await store.renameConversation(shared.id, 'shared with another project');

    const onlyA = await member(projectA, 'member');
    const res = await app.request(`/api/conversations?projectId=${projectA}&page=1&pageSize=1`, {
      headers: await auth(onlyA),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.items.map((i) => i.id)).toEqual([readable.id]);
    expect(body.total).toBe(1);
  });

  it('shows both rooms to a caller who holds a role on both projects', async () => {
    const first = await room(projectA);
    const shared = await room(projectA);
    const otherHandle = await harness.db.transaction(async (tx) =>
      handles.resolveProjectHandle(tx as never, projectB),
    );
    await participants.addHandle({
      conversationId: shared.id,
      handleUserId: otherHandle.userId,
      projectId: projectB,
      actorUserId: ownerId,
    });

    const res = await app.request(`/api/conversations?projectId=${projectA}`, {
      headers: await auth(ownerId),
    });
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.id).sort()).toEqual([first.id, shared.id].sort());
  });

  it('refuses a caller holding no role on the project asked for', async () => {
    await room(projectA);
    const stranger = await createTestUser(harness.db);
    await harness.db.execute(
      sql`UPDATE users SET email_verified_at = now() WHERE id = ${stranger.id}`,
    );
    const res = await app.request(`/api/conversations?projectId=${projectA}`, {
      headers: await auth(stranger.id),
    });
    expect(res.status).toBe(403);
  });
});
