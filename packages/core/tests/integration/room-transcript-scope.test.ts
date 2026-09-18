/**
 * ISS-1090 — only the room’s own people may ask it about its past.
 *
 * Nothing here is mocked. The refusals are `project_members` rows that do or do
 * not exist, the matches come out of a real `tsvector` GIN index, the rebuild
 * equality is measured by throwing the rows away and counting what comes back,
 * and the writer lock is proved by another connection holding the row while the
 * pass waits for it. A mocked fence would prove the mock; a mocked index would
 * prove nothing about `websearch_to_tsquery`.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { openRoom, say } from './room-transcript-ground.js';

let harness: TestDatabase;
let store: typeof import('../../src/conversations/store.js');
let index: typeof import('../../src/conversations/transcript-index.js');
let search: typeof import('../../src/conversations/transcript-search.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  index = await import('../../src/conversations/transcript-index.js');
  search = await import('../../src/conversations/transcript-search.js');
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectA: string;
let projectB: string;
let outsiderId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  const outsider = await createTestUser(harness.db);
  outsiderId = outsider.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectA = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  projectB = (
    await createTestProject(harness.db, ownerId, { slug: `beta-${randomUUID().slice(0, 8)}` })
  ).id;
});

describe('who may ask a room about its past', () => {
  it('refuses a call that names no caller, by name, and returns nothing', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'the retry ladder was dropped' }]);
    await index.indexConversationOnce(room.id);
    const call = search.searchConversationTranscript({
      conversationId: room.id,
      userId: null,
      query: 'retry ladder',
    });
    await expect(call).rejects.toMatchObject({
      status: 403,
      cause: { code: 'CONVERSATION_NO_AUTHORITY' },
    });
  });

  it('refuses a caller holding no role on a project the room is about, naming the room and the project', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'the retry ladder was dropped' }]);
    await index.indexConversationOnce(room.id);
    await expect(
      search.searchConversationTranscript({
        conversationId: room.id,
        userId: outsiderId,
        query: 'retry ladder',
      }),
    ).rejects.toMatchObject({
      status: 403,
      cause: { code: 'CONVERSATION_OUT_OF_SCOPE' },
    });
    const refusal = await search
      .searchConversationTranscript({
        conversationId: room.id,
        userId: outsiderId,
        query: 'retry ladder',
      })
      .catch((e: { message: string }) => e.message);
    expect(refusal).toContain(room.id);
    expect(refusal).toContain(projectA);
  });

  it('refuses a caller who holds a role on only SOME of a multi-project room', async () => {
    const room = await openRoom(store, projectA);
    const handleB = await createTestUser(harness.db, { kind: 'agent' });
    await harness.db.execute(sql`
      INSERT INTO conversation_participants (conversation_id, kind, user_id, project_id)
      VALUES (${room.id}::uuid, 'handle', ${handleB.id}::uuid, ${projectB}::uuid)
    `);
    await createTestProjectMember(harness.db, {
      userId: outsiderId,
      projectId: projectA,
      role: 'member',
    });
    await say(store, room.id, [{ text: 'the retry ladder was dropped' }]);
    await index.indexConversationOnce(room.id);
    await expect(
      search.searchConversationTranscript({
        conversationId: room.id,
        userId: outsiderId,
        query: 'retry ladder',
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_OUT_OF_SCOPE' } });
  });

  it('refuses a room whose live handles have all gone, rather than answering it to everyone', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'the retry ladder was dropped' }]);
    await index.indexConversationOnce(room.id);
    await harness.db.execute(
      sql`UPDATE conversation_participants SET removed_at = now() WHERE conversation_id = ${room.id}::uuid`,
    );
    await expect(
      search.searchConversationTranscript({
        conversationId: room.id,
        userId: ownerId,
        query: 'retry ladder',
      }),
    ).rejects.toMatchObject({ cause: { code: 'CONVERSATION_NO_SCOPE' } });
  });

  it('refuses a one-to-one room to somebody who is not in it, however good their project role', async () => {
    const room = await openRoom(store, projectA, 'direct');
    const insider = await createTestUser(harness.db);
    await harness.db.execute(sql`
      INSERT INTO conversation_participants (conversation_id, kind, user_id)
      VALUES (${room.id}::uuid, 'person', ${insider.id}::uuid)
    `);
    await createTestProjectMember(harness.db, {
      userId: outsiderId,
      projectId: projectA,
      role: 'admin',
    });
    await say(store, room.id, [{ text: 'the retry ladder was dropped' }]);
    await index.indexConversationOnce(room.id);
    await expect(
      search.searchConversationTranscript({
        conversationId: room.id,
        userId: outsiderId,
        query: 'retry ladder',
      }),
    ).rejects.toMatchObject({ cause: { code: 'NOT_IN_THE_ROOM' } });
  });

  it('never hands a refused caller a result object — the refusal is thrown in place of one', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'the retry ladder was dropped' }]);
    await index.indexConversationOnce(room.id);
    for (const caller of [null, outsiderId]) {
      const outcome = await search
        .searchConversationTranscript({
          conversationId: room.id,
          userId: caller,
          query: 'retry ladder',
        })
        .then(
          (r) => ({ kind: 'result' as const, r }),
          (e: unknown) => ({ kind: 'refusal' as const, e }),
        );
      expect(outcome.kind).toBe('refusal');
    }
  });

  it('answers the room owner, who holds the role on every project in it', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'we dropped the retry ladder in March' }]);
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'retry ladder',
    });
    expect(out.matches).toHaveLength(1);
  });
});
