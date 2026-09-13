/**
 * ISS-1001 — the store's concurrency claims, against a real Postgres over
 * INDEPENDENT connections.
 *
 * Every assertion here is about two writers that cannot see each other's
 * uncommitted work, which is the one thing a single-connection test and a
 * mocked drizzle chain both cannot represent: in either, the second writer sees
 * the first's row and the race never happens. So each case drives its writers
 * through their own pools, and where the ordering has to be exact a third
 * connection holds the lock or the row until both are in flight.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let store: typeof import('../../src/conversations/store.js');
let participants: typeof import('../../src/conversations/participants.js');
let scope: typeof import('../../src/conversations/scope.js');

/** Independent pools, so a writer here is a writer Postgres sees as a stranger. */
const clients: Sql[] = [];
function independent(): ReturnType<typeof drizzle> {
  const client = postgres(harness.url, { max: 2, onnotice: () => {} });
  clients.push(client);
  return drizzle(client, {});
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  participants = await import('../../src/conversations/participants.js');
  scope = await import('../../src/conversations/scope.js');
}, 120_000);

afterAll(async () => {
  for (const c of clients) await c.end({ timeout: 5 }).catch(() => {});
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectId: string;
let otherProjectId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  otherProjectId = (
    await createTestProject(harness.db, ownerId, { slug: `beta-${randomUUID().slice(0, 8)}` })
  ).id;
});

function venue(externalId: string, over: Record<string, unknown> = {}) {
  return {
    adapter: 'rocketchat' as const,
    externalId,
    shape: 'group' as const,
    projectId,
    ...over,
  };
}

async function countAgents(project: string): Promise<number> {
  const rows = await harness.db.execute(sql`
    SELECT count(*)::int AS n FROM users u
    JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ${project}
    WHERE u.kind = 'agent'`);
  return (rows[0] as unknown as { n: number }).n;
}

describe('two writers opening the same unseen venue', () => {
  it('settle on one conversation with one handle, and neither sees a handleless room', async () => {
    const a = independent();
    const b = independent();
    const key = `chat.example.co ${randomUUID()}`;

    const [first, second] = await Promise.all([
      store.openConversation(venue(key), { db: a as never }),
      store.openConversation(venue(key), { db: b as never }),
    ]);

    expect(first.id).toBe(second.id);
    const rows = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM conversations WHERE external_id = ${key}`,
    );
    expect((rows[0] as unknown as { n: number }).n).toBe(1);
    expect(await scope.derivedScope(first.id)).toEqual([projectId]);
    const live = await participants.listParticipants(first.id);
    expect(live.filter((p) => p.kind === 'handle')).toHaveLength(1);
  });

  // cm:guard the loser's branch is forced rather than hoped for: a third connection holds the row
  // uncommitted, so the writer under test MUST take the `DO NOTHING` path and re-read.
  it('takes the conflict path and re-reads rather than trusting an empty return', async () => {
    const key = `chat.example.co ${randomUUID()}`;
    const blocker = postgres(harness.url, { max: 1, onnotice: () => {} });
    clients.push(blocker);

    // cm:why the competing writer is a REAL one, committing the room and its handle together, because
    // that is what the loser has to find when it re-reads.
    const sibling = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const [handle] = await participants.listParticipants(sibling.id);
    const handleUserId = handle?.userId;
    expect(handleUserId).toBeTruthy();

    const planted = randomUUID();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocking = blocker.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO conversations (id, adapter, external_id, shape) VALUES ($1, 'rocketchat', $2, 'group')`,
        [planted, key],
      );
      await tx.unsafe(
        `INSERT INTO conversation_participants (conversation_id, kind, user_id) VALUES ($1, 'handle', $2)`,
        [planted, handleUserId as string],
      );
      await held;
    });

    const a = independent();
    const opening = store.openConversation(venue(key), { db: a as never });
    // cm:why the pause lets the opener reach its insert and block on the unique index before release.
    await new Promise((r) => setTimeout(r, 250));
    release();
    await blocking;

    const opened = await opening;
    expect(opened.id).toBe(planted);
  });

  it('refuses the same venue arriving under a second project rather than widening it', async () => {
    const key = `chat.example.co ${randomUUID()}`;
    await store.openConversation(venue(key));
    await expect(
      store.openConversation(venue(key, { projectId: otherProjectId })),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_PROJECT_CONFLICT' } });
  });

  it('refuses the same venue arriving with a different shape', async () => {
    const key = `chat.example.co ${randomUUID()}`;
    await store.openConversation(venue(key));
    await expect(store.openConversation(venue(key, { shape: 'direct' }))).rejects.toMatchObject({
      cause: { code: 'CONVERSATION_SHAPE_CONFLICT' },
    });
  });
});

describe('two first-time venues of one project with no handle yet', () => {
  // cm:guard the lock is what this proves: both writers are released at the same instant with neither
  // able to see the other's uncommitted user row, and the project must still end with ONE handle.
  it('mint exactly one handle between them', async () => {
    const gate = postgres(harness.url, { max: 1, onnotice: () => {} });
    clients.push(gate);

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = gate.begin(async (tx) => {
      await tx.unsafe(
        `SELECT pg_advisory_xact_lock(hashtext('forge:conversation-handle'), hashtext($1))`,
        [projectId],
      );
      await held;
    });
    await new Promise((r) => setTimeout(r, 100));

    const a = independent();
    const b = independent();
    const opens = Promise.all([
      store.openConversation(venue(`chat.example.co ${randomUUID()}`), { db: a as never }),
      store.openConversation(venue(`chat.example.co ${randomUUID()}`), { db: b as never }),
    ]);
    await new Promise((r) => setTimeout(r, 250));
    expect(await countAgents(projectId)).toBe(0);

    release();
    await holding;
    const [one, two] = await opens;

    expect(await countAgents(projectId)).toBe(1);
    expect(one.id).not.toBe(two.id);
    expect(await scope.derivedScope(one.id)).toEqual([projectId]);
    expect(await scope.derivedScope(two.id)).toEqual([projectId]);
  });
});

describe('appending turns', () => {
  it('numbers concurrent appends without losing one', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const writers = [independent(), independent(), independent(), independent()];
    await Promise.all(
      writers.map((db, i) =>
        store.appendMessage({
          conversationId: room.id,
          role: 'user',
          content: `turn ${i}`,
          db: db as never,
        }),
      ),
    );
    const rows = await store.readMessages(room.id, 50);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.map((r) => r.content)).size).toBe(4);
  });

  it('refuses an append to a conversation that is not there', async () => {
    await expect(
      store.appendMessage({ conversationId: randomUUID(), role: 'user', content: 'x' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('reads back the last turns oldest first, and counts them all', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    for (let i = 0; i < 5; i++) {
      await store.appendMessage({ conversationId: room.id, role: 'user', content: `m${i}` });
    }
    expect((await store.readMessages(room.id, 2)).map((r) => r.content)).toEqual(['m3', 'm4']);
    expect(await store.countMessages(room.id)).toBe(5);
  });

  it('stamps a delivered message with the receipt, and leaves the text alone', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const written = await store.appendMessage({
      conversationId: room.id,
      role: 'assistant',
      content: 'the answer',
    });
    expect(written.deliveryProof).toBeNull();

    await store.recordDelivery(written.id, { messageId: 'rc-server-id-9' });

    const [back] = await store.readMessages(room.id, 10);
    expect(back).toMatchObject({
      id: written.id,
      content: 'the answer',
      deliveryProof: { messageId: 'rc-server-id-9' },
    });
  });

  it('keeps a silence as a row rather than as an empty turn', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    await store.appendMessage({
      conversationId: room.id,
      role: 'assistant',
      content: '',
      silenceReason: 'turn threw',
    });
    const [only] = await store.readMessages(room.id, 10);
    expect(only).toMatchObject({ silenceReason: 'turn threw', content: '' });
  });
});

describe('listing a project’s conversations', () => {
  it('lists only the rooms whose handles reach that project', async () => {
    const mine = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const theirs = await store.openConversation(
      venue(`chat.example.co ${randomUUID()}`, { projectId: otherProjectId }),
    );
    const listed = await store.listConversationsInProject(projectId, { limit: 20, offset: 0 });
    expect(listed.map((r) => r.id)).toEqual([mine.id]);
    expect(listed.map((r) => r.id)).not.toContain(theirs.id);
    expect(await store.countConversationsInProject(projectId)).toBe(1);
  });

  it('drops a room from a project the moment its handle loses the role', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const [handle] = await participants.listParticipants(room.id);
    await harness.db.execute(
      sql`DELETE FROM project_members WHERE user_id = ${handle?.userId} AND project_id = ${projectId}`,
    );
    expect(await store.listConversationsInProject(projectId, { limit: 20, offset: 0 })).toEqual([]);
  });
});
