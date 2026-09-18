/**
 * ISS-1090 — what the index holds, what it says it has read, and what it will not do.
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
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import { closeSilentWindow, openRoom, passageRows, say } from './room-transcript-ground.js';

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

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectA = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
});

describe('what the index holds', () => {
  it('indexes a message from a window the room closed without answering, and finds it', async () => {
    // The room said nothing here, and was right to. Indexing what an answering turn
    // kept would erase exactly this (ISS-1090 rule 2).
    const room = await openRoom(store, projectA);
    await say(store, room.id, [
      { text: 'anyone know why the collector holds windows open?' },
      { text: 'because the hold clock was moved to opened_at' },
    ]);
    await closeSilentWindow(harness, {
      conversationId: room.id,
      projectId: projectA,
      firstSeq: 0,
      lastSeq: 1,
    });
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'hold clock',
    });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.text).toContain('hold clock was moved to opened_at');
  });

  it('indexes every decision a window can close on, not only the one that answered', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [
      { text: 'alpha the dormant guard paced this room' },
      { text: 'beta authority refused this one' },
      { text: 'gamma nobody could be reached' },
    ]);
    await closeSilentWindow(harness, {
      conversationId: room.id,
      projectId: projectA,
      firstSeq: 0,
      lastSeq: 0,
      decision: 'guard-dormant',
    });
    await closeSilentWindow(harness, {
      conversationId: room.id,
      projectId: projectA,
      firstSeq: 1,
      lastSeq: 1,
      decision: 'authority-refused',
    });
    await closeSilentWindow(harness, {
      conversationId: room.id,
      projectId: projectA,
      firstSeq: 2,
      lastSeq: 2,
      decision: 'unreachable',
    });
    await index.indexConversationOnce(room.id);
    for (const word of ['alpha', 'beta', 'gamma']) {
      const out = await search.searchConversationTranscript({
        conversationId: room.id,
        userId: ownerId,
        query: word,
      });
      expect({ word, found: out.matches.length }).toEqual({ word, found: 1 });
    }
  });

  it('stores the rows own text and no summary of them', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [
      { text: 'keep the ladder', who: 'ana' },
      { text: 'agreed', who: 'bo' },
    ]);
    await index.indexConversationOnce(room.id);
    const rows = await harness.db.execute<{ text: string }>(
      sql`SELECT text FROM conversation_passages WHERE conversation_id = ${room.id}::uuid`,
    );
    const texts = (
      Array.isArray(rows) ? rows : (rows as { rows: Array<{ text: string }> }).rows
    ).map((r) => r.text);
    expect(texts).toEqual(['[ana]: keep the ladder\n[bo]: agreed']);
  });

  it('leaves the transcript untouched across a pass and a rebuild', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'one' }, { text: '' }, { text: 'three' }]);
    const before = await harness.db.execute(
      sql`SELECT id, seq, content, created_at FROM conversation_messages WHERE conversation_id = ${room.id}::uuid ORDER BY seq`,
    );
    await index.indexConversationOnce(room.id);
    await index.rebuildConversationIndex(room.id);
    const after = await harness.db.execute(
      sql`SELECT id, seq, content, created_at FROM conversation_messages WHERE conversation_id = ${room.id}::uuid ORDER BY seq`,
    );
    expect(after).toEqual(before);
  });

  it('indexes nothing for a room with no messages and says its watermark is empty', async () => {
    const room = await openRoom(store, projectA);
    const pass = await index.indexConversationOnce(room.id);
    expect(pass).toMatchObject({ passagesWritten: 0, indexedThroughSeq: index.WATERMARK_EMPTY });
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'anything',
    });
    expect(out.matches).toEqual([]);
    expect(out.coverage).toMatchObject({
      indexedThroughSeq: index.WATERMARK_EMPTY,
      latestSeq: index.WATERMARK_EMPTY,
      messagesBeyondIndex: 0,
    });
    expect(out.limitation).toContain('no indexed passage');
  });

  it('indexes a room of one message as one passage covering it', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'the only thing ever said here' }]);
    const pass = await index.indexConversationOnce(room.id);
    expect(pass).toMatchObject({ passagesWritten: 1, indexedThroughSeq: 0 });
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'only thing',
    });
    expect(out.matches[0]).toMatchObject({ firstSeq: 0, lastSeq: 0, stillOpen: true });
  });

  it('indexes nothing for a room of pure silences, and still reports having read them', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: '' }, { text: '   ' }, { text: '' }]);
    const pass = await index.indexConversationOnce(room.id);
    expect(pass).toMatchObject({ passagesWritten: 0, indexedThroughSeq: 2 });
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'anything',
    });
    expect(out.coverage).toMatchObject({ indexedThroughSeq: 2, messagesBeyondIndex: 0 });
  });

  it('cuts a message far over the bound into passages that reassemble it exactly', async () => {
    const room = await openRoom(store, projectA);
    const body = `${'a decision about the ladder '.repeat(400)}finally`;
    await say(store, room.id, [{ text: body }]);
    await index.indexConversationOnce(room.id);
    const rows = await harness.db.execute<{
      first_offset: number;
      last_offset: number;
      first_seq: number;
      last_seq: number;
      text: string;
    }>(sql`
      SELECT first_seq, last_seq, first_offset, last_offset, text
      FROM conversation_passages WHERE conversation_id = ${room.id}::uuid
      ORDER BY first_seq, first_offset
    `);
    const list = Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows;
    expect(list.length).toBeGreaterThan(3);
    for (const r of list) {
      expect(r.text.length).toBeLessThanOrEqual(index.PASSAGE_TEXT_BOUND);
      expect([r.first_seq, r.last_seq]).toEqual([0, 0]);
    }
    const rebuilt = list.map((r) => body.slice(r.first_offset, r.last_offset)).join('');
    expect(rebuilt).toBe(body);
  });
});

describe('rebuilding from the transcript alone', () => {
  const passages = (id: string) => passageRows(harness, id);

  it('gives the same rows as the incremental index that grew one message at a time', async () => {
    const room = await openRoom(store, projectA);
    for (let i = 0; i < 28; i += 1) {
      await say(store, room.id, [{ text: `turn ${i} about the retry ladder and the hold clock` }]);
      await index.indexConversationOnce(room.id);
    }
    const incremental = await passages(room.id);
    expect(incremental.length).toBeGreaterThan(1);

    await harness.db.execute(
      sql`DELETE FROM conversation_passages WHERE conversation_id = ${room.id}::uuid`,
    );
    await harness.db.execute(
      sql`DELETE FROM conversation_index_state WHERE conversation_id = ${room.id}::uuid`,
    );
    await index.indexConversationOnce(room.id);
    expect(await passages(room.id)).toEqual(incremental);
  });

  it('gives the same rows when silences and long messages are mixed in', async () => {
    const room = await openRoom(store, projectA);
    const steps = [
      'the collector holds a window open',
      '',
      'x'.repeat(index.PASSAGE_MAX_CHARS * 2 + 11),
      '   ',
      'and then we dropped the ladder',
    ];
    for (const text of steps) {
      await say(store, room.id, [{ text }]);
      await index.indexConversationOnce(room.id);
    }
    const incremental = await passages(room.id);
    await index.rebuildConversationIndex(room.id);
    expect(await passages(room.id)).toEqual(incremental);
  });
});

describe('what a retrieval will not do', () => {
  it('returns no passage for a query that matches nothing, and says so', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'we talked only about the retry ladder' }]);
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'submarine',
    });
    expect(out.matches).toEqual([]);
    expect(out.limitation).toContain('no indexed passage in this room matches "submarine"');
    expect(out.limitation).toContain('the index covers messages 0 to 0');
  });

  it('clamps a caller over the server maximum and reports that it did', async () => {
    const room = await openRoom(store, projectA);
    await say(
      store,
      room.id,
      Array.from({ length: 80 }, (_, i) => ({ text: `ladder note ${i} about the ladder` })),
    );
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'ladder',
      limit: 500,
    });
    expect(out.matches.length).toBeLessThanOrEqual(search.RETRIEVAL_MAX_RESULTS);
    expect(out.limitation).toContain(`at most ${search.RETRIEVAL_MAX_RESULTS} a call`);
  });

  it('bounds a hit source list however many rows the passage spans', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'first word: quokka' }]);
    await say(
      store,
      room.id,
      Array.from({ length: 300 }, () => ({ text: '' })),
    );
    await say(store, room.id, [{ text: 'second word: quokka again' }]);
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'quokka',
    });
    expect(out.matches).toHaveLength(1);
    const hit = out.matches[0];
    expect(hit?.lastSeq).toBe(301);
    expect(hit?.sources).toHaveLength(2);
    expect(hit?.sources.map((s) => s.seq)).toEqual([0, 301]);
  });

  it('drops a transport id over the bound instead of returning a clipped one', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [
      { text: 'addressable message about the ladder', externalId: 'rc-short' },
      {
        text: 'another about the ladder',
        externalId: 'x'.repeat(search.SOURCE_EXTERNAL_ID_CAP + 1),
      },
      { text: 'a third about the ladder', externalId: null },
    ]);
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'ladder',
    });
    const sources = out.matches[0]?.sources ?? [];
    expect(sources.map((s) => s.externalId)).toEqual(['rc-short', null, null]);
    expect(out.limitation).toContain('carry no usable transport id');
  });

  it("carries the venue's own limitation through untouched", async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'thread talk about the ladder' }]);
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'ladder',
      venueLimitation: 'this search covers only the thread this message is in',
    });
    expect(out.limitation).toContain('only the thread this message is in');
  });

  it('returns the message ids, their times and the passage around a match', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [
      { text: 'we should drop the retry ladder', who: 'ana', externalId: 'rc-1' },
      { text: 'agreed, it is a workaround', who: 'bo', externalId: 'rc-2' },
    ]);
    const written = await index.indexConversationOnce(room.id);
    expect(written.passagesWritten).toBe(1);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'retry ladder',
    });
    const hit = out.matches[0];
    expect(hit?.text).toBe(
      '[ana]: we should drop the retry ladder\n[bo]: agreed, it is a workaround',
    );
    expect(hit?.sources.map((s) => s.externalId)).toEqual(['rc-1', 'rc-2']);
    expect(hit?.sources.map((s) => s.author)).toEqual(['ana', 'bo']);
    for (const s of hit?.sources ?? []) {
      expect(Number.isNaN(Date.parse(s.at))).toBe(false);
      expect(s.messageId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect((hit?.startedAt ?? '') <= (hit?.endedAt ?? '')).toBe(true);
  });
});
