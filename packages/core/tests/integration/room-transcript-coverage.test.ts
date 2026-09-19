/**
 * ISS-1090 — how far the index says it has read, and whether that figure is true of the
 * index the same read was served.
 *
 * Split from `room-transcript-index.test.ts` because these are a different question about
 * the same fixtures: not what a passage holds, but what a caller is told about the rows
 * that are NOT in one. Nothing here is mocked — the interleavings are two real connections.
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
import { openRoom, passageRows, say } from './room-transcript-ground.js';

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

const clients: Sql[] = [];
function independent(): { db: ReturnType<typeof drizzle>; client: Sql } {
  const client = postgres(harness.url, { max: 2, onnotice: () => {} });
  clients.push(client);
  return { db: drizzle(client, {}), client };
}

afterAll(async () => {
  for (const c of clients) await c.end({ timeout: 5 }).catch(() => {});
  if (harness) await harness.cleanup();
});

/**
 * A drizzle query builder that will not reach the database until `gate` has settled.
 */
function gated<T>(builder: T, gate: Promise<unknown>): T {
  return new Proxy(builder as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'then' && typeof value === 'function') {
        return (onOk: unknown, onErr: unknown) =>
          gate.then(() => (value as (a: unknown, b: unknown) => unknown).call(target, onOk, onErr));
      }
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        gated((value as (...a: unknown[]) => unknown).apply(target, args), gate);
    },
  }) as T;
}

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

describe('the coverage watermark', () => {
  it('never reports further than the row the pass actually read', async () => {
    const room = await openRoom(store, projectA);
    const many = Array.from({ length: index.INDEX_PASS_MESSAGE_LIMIT + 100 }, (_, i) => ({
      text: `line ${i} of a very long room`,
    }));
    await say(store, room.id, many);
    const first = await index.indexConversationOnce(room.id);
    expect(first.indexedThroughSeq).toBe(index.INDEX_PASS_MESSAGE_LIMIT - 1);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'very long room',
    });
    expect(out.coverage).toMatchObject({
      indexedThroughSeq: index.INDEX_PASS_MESSAGE_LIMIT - 1,
      latestSeq: index.INDEX_PASS_MESSAGE_LIMIT + 99,
      messagesBeyondIndex: 100,
    });
    expect(out.limitation).toContain('100 newer message(s) are not in it yet');
    const second = await index.indexConversationOnce(room.id);
    expect(second.indexedThroughSeq).toBe(index.INDEX_PASS_MESSAGE_LIMIT + 99);
  });

  it('advances past a long run of silences instead of re-reading the same prefix for ever', async () => {
    // The open tail sits at seq 0 and everything after it is a silence, so a pass that
    // spent its budget from the resume point would never reach the last message.
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'the first and only early word: aardvark' }]);
    await index.indexConversationOnce(room.id);
    await say(
      store,
      room.id,
      Array.from({ length: index.INDEX_PASS_MESSAGE_LIMIT + 5 }, () => ({ text: '' })),
    );
    await say(store, room.id, [{ text: 'the late word: zebra' }]);
    for (let i = 0; i < 4; i += 1) await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'zebra',
    });
    expect(out.matches).toHaveLength(1);
    expect(out.coverage.messagesBeyondIndex).toBe(0);
  });

  it('advances past silences that are tabs and newlines, which SQL and TypeScript must agree are empty', async () => {
    // `btrim` with no second argument trims SPACES only, so a `\n`-only row reads as text to
    // Postgres and as a silence to `eligibleForIndex`. The tail then counts eleven messages
    // against a ceiling of ten and every later pass throws, for ever.
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'the early word: aardvark' }]);
    await index.indexConversationOnce(room.id);
    await say(
      store,
      room.id,
      Array.from({ length: 12 }, (_, i) => ({ text: i % 2 === 0 ? '\n' : '\t  \r' })),
    );
    await say(store, room.id, [{ text: 'the late word: zebra' }]);
    const pass = await index.indexConversationOnce(room.id);
    expect(pass.indexedThroughSeq).toBe(13);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'zebra',
    });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.sources.map((source) => source.seq)).toEqual([0, 13]);
  });
});

describe('one snapshot, one index', () => {
  it('reports a rebuild that has not caught up rather than the coverage it had before', async () => {
    // A rebuild throws every passage away and re-indexes a bounded batch, so the watermark
    // GOES DOWN while it runs. A caller told the old figure would be told the room is fully
    // indexed by an index that no longer holds most of it.
    const room = await openRoom(store, projectA);
    await say(
      store,
      room.id,
      Array.from({ length: index.INDEX_PASS_MESSAGE_LIMIT + 100 }, (_, i) => ({
        text: `note ${i} about the ladder`,
      })),
    );
    await index.indexConversationOnce(room.id);
    await index.indexConversationOnce(room.id);
    const full = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'ladder',
    });
    expect(full.coverage.messagesBeyondIndex).toBe(0);

    await index.rebuildConversationIndex(room.id);
    const during = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'ladder',
    });
    expect(during.coverage).toMatchObject({
      indexedThroughSeq: index.INDEX_PASS_MESSAGE_LIMIT - 1,
      messagesBeyondIndex: 100,
    });
    expect(during.limitation).toContain('100 newer message(s) are not in it yet');
  });

  it('holds one snapshot across a rebuild that commits between its coverage read and its hits', async () => {
    // What the retrieval rests on, driven through the real door rather than around it: the
    // room is read through a connection whose THIRD statement — the hit query, after the two
    // coverage reads — is made to wait while an independent connection commits a rebuild that
    // throws every passage away and re-indexes only its first batch. Inside `repeatable read`
    // the reader still sees the index it started on, so the figure it reports and the passages
    // it reports are one index. Take the transaction off `searchConversationTranscript` and
    // this goes red exactly here: full coverage claimed over a passage the rebuild deleted.
    const room = await openRoom(store, projectA);
    await say(
      store,
      room.id,
      Array.from({ length: index.INDEX_PASS_MESSAGE_LIMIT + 100 }, (_, i) => ({
        text: i === index.INDEX_PASS_MESSAGE_LIMIT + 50 ? 'the late word: quetzal' : `note ${i}`,
      })),
    );
    await index.indexConversationOnce(room.id);
    await index.indexConversationOnce(room.id);

    const reader = independent();
    let statements = 0;
    let rebuilt: Promise<unknown> | null = null;
    // Counts the SELECTs the read issues and gates the third — the hit query, after the two
    // coverage reads — behind a rebuild committed on another connection. Applied to the
    // transaction's handle as well as to the database, so the interleaving happens whether or
    // not `searchConversationTranscript` opens a transaction at all: that is what makes this
    // go red when the wrapper is taken off rather than quietly testing nothing.
    const counting = <T>(obj: T): T =>
      new Proxy(obj as object, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          if (prop === 'transaction') {
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              (value as (...a: unknown[]) => unknown).apply(target, [
                (tx: unknown) => fn(counting(tx)),
                ...rest,
              ]);
          }
          if (prop !== 'select')
            return (...args: unknown[]) =>
              (value as (...a: unknown[]) => unknown).apply(target, args);
          return (...args: unknown[]) => {
            statements += 1;
            const builder = (value as (...a: unknown[]) => unknown).apply(target, args);
            if (statements !== 3) return builder;
            rebuilt ??= index.rebuildConversationIndex(room.id);
            return gated(builder, rebuilt);
          };
        },
      }) as T;

    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'quetzal',
      db: counting(reader.db) as never,
    });
    expect(rebuilt).not.toBeNull();
    await rebuilt;
    expect(out.coverage).toMatchObject({
      indexedThroughSeq: index.INDEX_PASS_MESSAGE_LIMIT + 99,
      messagesBeyondIndex: 0,
    });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.text).toContain('quetzal');
    // And the rebuild really did land under it: the committed index is the shorter one.
    const state = await harness.db.execute(
      sql`SELECT indexed_through_seq AS n FROM conversation_index_state WHERE conversation_id = ${room.id}::uuid`,
    );
    const committed = Array.isArray(state) ? state : (state as { rows: { n: number }[] }).rows;
    expect((committed as { n: number }[])[0]?.n).toBe(index.INDEX_PASS_MESSAGE_LIMIT - 1);
  });

  it('agrees with SQL about a space JavaScript does not trim, so no room silently loses a line', async () => {
    // `sourceOf` trims six ASCII code points and keeps U+2003 EM SPACE; `[[:space:]]` under a
    // UTF-8 ctype does not (and neither does JavaScript's own `trim()`, which is why the rule
    // is an explicit class rather than a call to it). A row of nothing but an em space is then
    // built into a passage and invisible to every SQL read over the same rows: its text sits in
    // a passage nobody can attribute, and once it is the open tail the next pass cannot find it
    // to resume from.
    const emSpace = '\u2003';
    const room = await openRoom(store, projectA);
    await say(store, room.id, [
      { text: 'the early word: aardvark' },
      { text: emSpace },
      { text: 'the late word: zebra' },
    ]);
    await index.indexConversationOnce(room.id);
    const out = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'zebra',
    });
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.sources.map((source) => source.seq)).toEqual([0, 1, 2]);
    expect(out.matches[0]?.text).toContain(emSpace);

    // And the tail it leaves behind is re-readable: an incremental pass over it lands on the
    // same rows a rebuild from the transcript alone produces.
    await say(store, room.id, [{ text: 'a later word: xylophone' }]);
    await index.indexConversationOnce(room.id);
    const incremental = await passageRows(harness, room.id);
    await index.rebuildConversationIndex(room.id);
    expect(await passageRows(harness, room.id)).toEqual(incremental);
  });

  it('names what is beyond it and finds it once the next pass has run', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [
      { text: 'the old decision about the ladder', externalId: 'rc-old' },
    ]);
    await index.indexConversationOnce(room.id);
    await say(store, room.id, [{ text: 'a brand new word: xylophone', externalId: 'rc-new' }]);

    const before = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'xylophone',
    });
    expect(before.matches).toEqual([]);
    expect(before.limitation).toContain('1 newer message(s) are not in it yet');
    expect(before.coverage).toMatchObject({ indexedThroughSeq: 0, messagesBeyondIndex: 1 });

    await index.indexConversationOnce(room.id);
    const after = await search.searchConversationTranscript({
      conversationId: room.id,
      userId: ownerId,
      query: 'xylophone',
    });
    expect(after.matches).toHaveLength(1);
    expect(after.limitation).toBeNull();
  });

  it('waits for the room writer lock rather than indexing across an append', async () => {
    const room = await openRoom(store, projectA);
    await say(store, room.id, [{ text: 'something to index' }]);
    const other = independent();
    let released = false;
    let locked: () => void = () => {};
    const lockTaken = new Promise<void>((r) => {
      locked = r;
    });
    const held = other.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM conversations WHERE id = ${room.id}::uuid FOR UPDATE`);
      locked();
      await new Promise((r) => setTimeout(r, 700));
      released = true;
    });
    await lockTaken;
    const pass = index.indexConversationOnce(room.id).then((p) => {
      expect(released).toBe(true);
      return p;
    });
    await Promise.all([held, pass]);
    expect((await pass).indexedThroughSeq).toBe(0);
  });
});
