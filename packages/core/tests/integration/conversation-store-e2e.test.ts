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
let transcript: typeof import('../../src/conversations/transcript.js');

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
  transcript = await import('../../src/conversations/transcript.js');
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

  /**
   * Wait until some connection is blocked on a lock, and not merely slow.
   */
  // cm:guard it reads `pg_stat_activity` rather than sleeping, because a duration is a guess that a busy runner falsifies in both directions: too short and the conflict path is never entered, too long and the test pays for it on every run.
  // cm:guard it matches the STATEMENT and not the venue key, because drizzle sends the key as a bind parameter and `pg_stat_activity.query` holds the text with `$1` in its place — a LIKE on the key never matches and the wait becomes a hang.
  async function blockedOnConversationInsert(within = 10_000): Promise<boolean> {
    const until = Date.now() + within;
    while (Date.now() < until) {
      const rows = await harness.db.execute(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%insert into "conversations"%'`,
      );
      if ((rows[0] as unknown as { n: number }).n > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  // cm:guard the loser's branch is forced rather than hoped for: a third connection holds the row uncommitted, so the writer under test MUST take the `DO NOTHING` path and re-read.
  it('takes the conflict path and re-reads rather than trusting an empty return', async () => {
    const key = `chat.example.co ${randomUUID()}`;
    const blocker = postgres(harness.url, { max: 1, onnotice: () => {} });
    clients.push(blocker);

    // cm:why the competing writer is a REAL one, committing the room and its handle together, because that is what the loser has to find when it re-reads.
    const sibling = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const [handle] = await participants.listParticipants(sibling.id);
    const handleUserId = handle?.userId;
    expect(handleUserId).toBeTruthy();
    // cm:guard the planted row carries the handle's project, because since ISS-1003 a live handle without one violates `conversation_participants_handle_has_project` — a competing writer that could not exist is no competitor, and the loser's branch would never be reached.
    const handleProjectId = handle?.projectId;
    expect(handleProjectId).toBeTruthy();

    const planted = randomUUID();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let planting: () => void = () => {};
    const plantedRow = new Promise<void>((resolve) => {
      planting = resolve;
    });
    const blocking = blocker.begin(async (tx) => {
      await tx.unsafe(
        `INSERT INTO conversations (id, adapter, external_id, shape) VALUES ($1, 'rocketchat', $2, 'group')`,
        [planted, key],
      );
      await tx.unsafe(
        `INSERT INTO conversation_participants (conversation_id, kind, user_id, project_id) VALUES ($1, 'handle', $2, $3)`,
        [planted, handleUserId as string, handleProjectId as string],
      );
      planting();
      await held;
    });

    // cm:guard the opener does not start until the planted row is actually IN the blocker's transaction, and this was a 250ms sleep: on a loaded runner the opener won it, committed its own row first, and the planted INSERT — which is raw and has no `ON CONFLICT` — died on `conversations_venue_unique` as an unhandled rejection. The test then reported the loser's branch as broken when what had failed was its own scaffolding (measured on CI 2026-09-14).
    await plantedRow;
    const a = independent();
    const opening = store.openConversation(venue(key), { db: a as never });
    // cm:guard the release waits for the opener to be BLOCKED ON THE LOCK rather than for a duration, which is what makes "the loser's branch is forced" a fact: released early the opener's pre-read finds the committed row and the conflict path is never taken, so the assertion passes over the case it exists for.
    const forced = await blockedOnConversationInsert();
    release();
    await blocking;
    // cm:guard asserted rather than assumed: released before the opener reached its insert, the pre-read finds the committed row and the conflict path is never entered, so the assertion below would pass over the case this test exists for.
    expect(forced).toBe(true);

    const opened = await opening;
    expect(opened.id).toBe(planted);
  });

  it('answers the same conversation on a second resolve of one venue key', async () => {
    const key = `chat.example.co ${randomUUID()}`;
    const first = await store.openConversation(venue(key));
    const again = await store.openConversation(venue(key));
    expect(again.id).toBe(first.id);
    const rows = await harness.db.execute(
      sql`SELECT count(*)::int AS n FROM conversations WHERE external_id = ${key}`,
    );
    expect((rows[0] as unknown as { n: number }).n).toBe(1);
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
  // cm:guard the lock is what this proves: both writers are released at the same instant with neither able to see the other's uncommitted user row, and the project must still end with ONE handle.
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

  // cm:guard an append TOUCHES no row already there: the blob it replaced was rewritten whole on every turn, which is how a concurrent write lost one, and the ids and timestamps here are what say so.
  it('leaves every row already in the conversation exactly as it was', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const first = await store.appendMessage({
      conversationId: room.id,
      role: 'user',
      content: 'first',
    });
    const before = await store.readMessages(room.id, 10);

    await store.appendMessage({ conversationId: room.id, role: 'assistant', content: 'second' });

    const after = await store.readMessages(room.id, 10);
    expect(after[0]).toEqual(before[0]);
    expect(after[0]?.id).toBe(first.id);
    expect(after).toHaveLength(2);
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

  // cm:guard the receipt reaches the row through the ONE record door and nothing else stamps it: a turn that screens writes no answer row of its own, so an answer with no receipt on it is an answer nothing can show was ever posted (ISS-1002 replaced `recordDelivery`, which by then had no caller a screened turn could reach).
  it('records a delivered reply as the assistant row, with the receipt the transport returned', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));

    await transcript.recordDeliveredReply({
      conversationId: room.id,
      projectId,
      text: 'the answer',
      receipt: { messageId: 'rc-server-id-9' },
    });

    const [back] = await store.readMessages(room.id, 10);
    expect(back).toMatchObject({
      role: 'assistant',
      content: 'the answer',
      deliveryProof: { messageId: 'rc-server-id-9' },
    });
    expect(back?.authorUserId).not.toBeNull();
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

/**
 * ISS-1029 — the blocks column, against a real Postgres: what goes in comes
 * back, and the shape that predates the column is still writable and still
 * readable.
 */
describe('the canonical blocks column', () => {
  const blocks = [
    { type: 'text' as const, text: 'Let me look.' },
    {
      type: 'tool' as const,
      toolCall: {
        id: 'c1',
        name: 'forge_issues',
        input: { action: 'list' },
        output: 'two issues',
        isError: true,
        durationMs: 12,
      },
    },
    { type: 'text' as const, text: 'That failed.' },
  ];

  it('round-trips the ordered blocks a turn wrote', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const written = await store.appendMessage({
      conversationId: room.id,
      role: 'assistant',
      content: 'That failed.',
      blocks,
    });
    expect(written.blocks).toEqual(blocks);

    const [read] = await store.readMessages(room.id, 50);
    expect(read?.blocks).toEqual(blocks);
    const entry = store.toCanonicalEntry(read as never);
    expect(entry.type).toBe('assistant');
    expect(entry.blocks).toEqual(blocks);
    expect(entry.toolCalls).toEqual([(blocks[1] as { toolCall: unknown }).toolCall]);
  });

  // cm:guard criterion 20 — the previous shape, which names no blocks at all, still writes. The
  // migration adds a NULLABLE column with no default precisely so this holds; a NOT NULL there
  // would have made every older writer's insert a 500 the moment the ALTER landed.
  it('still accepts an insert that names no blocks', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const written = await store.appendMessage({
      conversationId: room.id,
      role: 'assistant',
      content: 'You have two.',
    });
    expect(written.blocks).toBeNull();
  });

  // cm:guard criterion 19 — a row carrying the pre-column shape reads back through the NEW reader
  // as the answer it holds, not as an empty turn. This is written with raw SQL naming only the
  // columns that existed before 0247, which is exactly what a row already in the table looks like.
  it('reads a row written in the pre-column shape as a single text block', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    await harness.db.execute(sql`
      INSERT INTO conversation_messages (conversation_id, seq, role, content)
      VALUES (${room.id}, 0, 'assistant', 'You have two.')
    `);
    const [read] = await store.readMessages(room.id, 50);
    expect(read?.blocks).toBeNull();
    expect(store.toCanonicalEntry(read as never).blocks).toEqual([
      { type: 'text', text: 'You have two.' },
    ]);
  });

  it('keeps an empty blocks array out of the column', async () => {
    const room = await store.openConversation(venue(`chat.example.co ${randomUUID()}`));
    const written = await store.appendMessage({
      conversationId: room.id,
      role: 'assistant',
      content: 'hi',
      blocks: [],
    });
    expect(written.blocks).toBeNull();
  });
});
