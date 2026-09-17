/**
 * ISS-1004 — the collector window's concurrency claims, against a real Postgres
 * over INDEPENDENT connections.
 *
 * Every property this table exists for is a race, and a race is the one thing a
 * single connection and a mocked drizzle chain both cannot represent: in either,
 * the second writer sees the first's uncommitted row and the collision never
 * happens. The partial unique index, the skip-locked claim and the lease each
 * get two strangers here, and the assertion is what the database was left
 * holding.
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
let windows: typeof import('../../src/conversations/windows.js');
let collect: typeof import('../../src/conversations/collect-inbound.js');
let ports: typeof import('../../src/conversations/ports.js');

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
  windows = await import('../../src/conversations/windows.js');
  collect = await import('../../src/conversations/collect-inbound.js');
  ports = await import('../../src/conversations/ports.js');
}, 120_000);

afterAll(async () => {
  for (const c of clients) await c.end({ timeout: 5 }).catch(() => {});
  if (harness) await harness.cleanup();
});

let ownerId: string;
let projectId: string;
let conversationId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (
    await createTestProject(harness.db, ownerId, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  const conversation = await store.openConversation({
    adapter: 'rocketchat',
    externalId: `chat.example.co ${randomUUID()}`,
    shape: 'group',
    projectId,
  });
  conversationId = conversation.id;
});

const open = (seq: number, db?: ReturnType<typeof drizzle>) =>
  windows.openOrExtendWindow(
    { conversationId, projectId, adapter: 'rocketchat', seq },
    db as never,
  );

const claim = (over: Record<string, unknown> = {}) =>
  windows.claimDueWindows({
    adapter: 'rocketchat',
    claimant: 'core-1',
    limit: 10,
    settleMs: 0,
    ...over,
  } as never);

/**
 * Which constraint refused a statement.
 */
// cm:guard the NAME and not the message: drizzle wraps a driver error in its own, whose text is the SQL that failed — so `toThrow(/constraint/)` passes for any refusal at all, including a typo in the statement, and the assertion would be green over a table with no constraints on it.
async function refusedBy(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'nothing refused it';
  } catch (err) {
    const cause = (err as { cause?: { constraint_name?: string } }).cause;
    return cause?.constraint_name ?? String(err);
  }
}

async function windowCount(): Promise<number> {
  const rows = await harness.db.execute(
    sql`SELECT count(*)::int AS n FROM conversation_windows WHERE conversation_id = ${conversationId}`,
  );
  return (rows[0] as unknown as { n: number }).n;
}

describe('a window is extended, never doubled', () => {
  it('gives two messages arriving together one window', async () => {
    const first = await open(0);
    const second = await open(1);

    expect(second.id).toBe(first.id);
    expect(second.firstSeq).toBe(0);
    expect(second.lastSeq).toBe(1);
    expect(await windowCount()).toBe(1);
  });

  // cm:guard two strangers, because a single connection sees its own uncommitted insert and the partial unique index is never asked the question this table added it for (ISS-1004 rule 1).
  it('settles two simultaneous collectors on one window', async () => {
    const a = independent();
    const b = independent();

    const [first, second] = await Promise.all([open(0, a), open(1, b)]);

    expect(first.id).toBe(second.id);
    expect(await windowCount()).toBe(1);
  });

  // cm:guard the predicate is `claimed_at IS NULL` and not `closed_at IS NULL`, and this is the case that separates them: a window being routed has already read its messages, so a message arriving mid-route must open the SUCCESSOR rather than join a decision that can no longer see it (ISS-1004 review F2).
  it('opens a successor for a message that arrives while the window is being routed', async () => {
    const first = await open(0);
    const [claimed] = await claim();
    expect(claimed?.id).toBe(first.id);

    const successor = await open(1);

    expect(successor.id).not.toBe(first.id);
    expect(successor.firstSeq).toBe(1);
    expect(await windowCount()).toBe(2);
  });
});

describe('a window is claimed before it routes', () => {
  it('is taken by exactly one of two cores racing for it', async () => {
    await open(0);
    const a = independent();
    const b = independent();

    const [first, second] = await Promise.all([
      windows.claimDueWindows(
        { adapter: 'rocketchat', claimant: 'core-a', limit: 10, settleMs: 0 },
        a as never,
      ),
      windows.claimDueWindows(
        { adapter: 'rocketchat', claimant: 'core-b', limit: 10, settleMs: 0 },
        b as never,
      ),
    ]);

    expect(first.length + second.length).toBe(1);
  });

  it('is not claimed again while its lease is live', async () => {
    await open(0);
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toHaveLength(0);
  });

  // cm:guard the lease is what recovers a core that claimed a window and stopped: without it a non-null `claimed_at` wedges the window for good, which is the restart durability the row was added for (ISS-1004 review F1).
  it('is claimable again once the lease has expired', async () => {
    await open(0);
    expect(await claim()).toHaveLength(1);
    const again = await claim({ leaseMs: 0 });
    expect(again).toHaveLength(1);
    expect(again[0]?.claimedBy).toBe('core-1');
  });

  it('is not claimed before it has settled', async () => {
    await open(0);
    expect(await claim({ settleMs: 60_000 })).toHaveLength(0);
  });

  it('carries the venue it belongs to, so the adapter reads no store row', async () => {
    await open(0);
    const [claimed] = await claim();
    expect(claimed?.venueExternalId).toMatch(/^chat\.example\.co /);
    expect(claimed?.venueShape).toBe('group');
  });

  it('is not claimed by a core that binds none of its rooms', async () => {
    await open(0);
    expect(await claim({ venuePrefixes: ['chat.other.co room-9'] })).toHaveLength(0);
    expect(await claim({ venuePrefixes: ['chat.example.co'] })).toHaveLength(1);
  });

  // cm:guard a release is NOT a close: a core that finds it cannot deliver here has taken no decision, and writing one would tell a person their message was considered and refused when nobody looked at it (ISS-1004 rule 4).
  it('goes back to collecting when it is released', async () => {
    await open(0);
    const [claimed] = await claim();
    await windows.releaseWindow(claimed?.id as string, windows.claimOf(claimed as never) as never);

    const again = await claim();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(claimed?.id);
  });
});

describe('a window that closes says why', () => {
  it('carries its decision, and refuses a second one', async () => {
    await open(0);
    const [claimed] = await claim();
    const id = claimed?.id as string;

    const held = windows.claimOf(claimed as never) as never;
    expect(
      await windows.closeWindow({ windowId: id, decision: 'guard-backoff', claim: held }),
    ).toMatchObject({ decision: 'guard-backoff' });
    expect(
      await windows.closeWindow({ windowId: id, decision: 'answered', claim: held }),
    ).toBeNull();
    expect((await windows.getWindow(id))?.decision).toBe('guard-backoff');
  });

  // cm:guard the constraint, planted rather than assumed: a close with no decision is the unreadable silence this table exists to make impossible, and a convention would not have stopped it.
  it('cannot be closed with no decision at all', async () => {
    await open(0);
    const [claimed] = await claim();
    expect(
      await refusedBy(
        harness.db.execute(
          sql`UPDATE conversation_windows SET closed_at = now() WHERE id = ${claimed?.id as string}`,
        ),
      ),
    ).toBe('conversation_windows_closed_has_decision');
  });

  // cm:guard a close is a route and a route is claimed first: an unclaimed close is a decision two cores could both have taken.
  it('cannot be closed before it is claimed', async () => {
    const win = await open(0);
    expect(
      await refusedBy(
        harness.db.execute(
          sql`UPDATE conversation_windows SET closed_at = now(), decision = 'answered' WHERE id = ${win.id}`,
        ),
      ),
    ).toBe('conversation_windows_closed_was_claimed');
  });

  it('admits only decisions the vocabulary names', async () => {
    await open(0);
    const [claimed] = await claim();
    expect(
      await refusedBy(
        harness.db.execute(
          sql`UPDATE conversation_windows SET closed_at = now(), decision = 'shrug' WHERE id = ${claimed?.id as string}`,
        ),
      ),
    ).toBe('conversation_windows_decision_known');
  });

  it('lists the decisions a room has settled on, newest first', async () => {
    await open(0);
    const [one] = await claim();
    await windows.closeWindow({
      windowId: one?.id as string,
      decision: 'nothing-to-say',
      claim: windows.claimOf(one as never) as never,
    });
    await open(1);
    const [two] = await claim();
    await windows.closeWindow({
      windowId: two?.id as string,
      decision: 'answered',
      claim: windows.claimOf(two as never) as never,
    });

    expect((await windows.recentDecisions(conversationId)).map((d) => d.decision)).toEqual([
      'answered',
      'nothing-to-say',
    ]);
  });
});

describe('a collected message and its window', () => {
  interface Frame {
    externalId: string;
    projectId: string;
    text: string;
  }

  function adapter(over: Partial<Record<string, unknown>> = {}) {
    return {
      adapter: 'rocketchat' as const,
      resolveVenue: async (f: Frame) => ({
        adapter: 'rocketchat' as const,
        externalId: f.externalId,
        shape: 'group' as const,
        projectId: f.projectId,
      }),
      resolveSpeaker: async () => ({ linked: true as const, userId: ownerId }),
      deliver: async () => ({ messageId: null }),
      fetchHistory: async () => [],
      ...over,
    };
  }

  const collectOne = (frame: Frame, over = {}) =>
    collect.collectInboundMessage({
      ports: adapter(over) as never,
      frame,
      message: frame.text,
      speakerKey: 'rc-user-1',
      speakerLabel: 'alice',
      externalMessageId: 'rc-msg-1',
      manySpeakersPrincipalUserId: ownerId,
    });

  beforeEach(() => {
    ports.clearConversationTransports();
    ports.registerConversationTransport(adapter() as never);
  });

  it('puts the message in the log and in a window, under one commit', async () => {
    const externalId = `chat.example.co ${randomUUID()}`;
    const outcome = await collectOne({ externalId, projectId, text: 'why is CI red?' });

    expect(outcome.kind).toBe('collected');
    const conversation = await store.findConversation('rocketchat', externalId);
    const rows = await store.readMessages(conversation?.id as string, 10);
    expect(rows.map((r) => r.content)).toEqual(['why is CI red?']);
    expect(rows[0]?.externalId).toBe('rc-msg-1');
    const [claimed] = await windows.claimDueWindows({
      adapter: 'rocketchat',
      claimant: 'core-1',
      limit: 10,
      settleMs: 0,
      venuePrefixes: [externalId],
    });
    expect(claimed?.firstSeq).toBe(rows[0]?.seq);
  });

  // cm:guard the range read, planted: a window claimed while its successor keeps collecting can have its whole contents pushed past the conversation's newest rows, and a reader that took the tail and filtered it found nothing — which closed a person's question `unreachable` for good (ISS-1004, review pass 1 F4).
  it('reads an older window own messages from behind a busy successor', async () => {
    const externalId = `chat.example.co ${randomUUID()}`;
    await collectOne({ externalId, projectId, text: 'the question nobody answered' });
    const conversation = await store.findConversation('rocketchat', externalId);
    const id = conversation?.id as string;

    const [mine] = await windows.claimDueWindows({
      adapter: 'rocketchat',
      claimant: 'core-1',
      limit: 10,
      settleMs: 0,
      venuePrefixes: [externalId],
    });
    for (let i = 0; i < 60; i++) {
      await collectOne({ externalId, projectId, text: `later chatter ${i}` });
    }

    const tail = await store.readMessages(id, 50);
    expect(tail.some((m) => m.seq === mine?.firstSeq)).toBe(false);

    const own = await store.readMessagesInRange(id, {
      firstSeq: mine?.firstSeq as number,
      lastSeq: mine?.lastSeq as number,
      limit: 50,
    });
    expect(own.map((m) => m.content)).toEqual(['the question nobody answered']);
  });

  // cm:guard a venue arriving under a project the room is not about is refused BEFORE anything is written: the atomicity of the pair is proved in `conversation-collect-atomic-e2e.test.ts`, and what this holds is that a refused venue leaves no message and no window either (ISS-1001).
  it('writes nothing for a venue bound to a project the room is not about', async () => {
    const externalId = `chat.example.co ${randomUUID()}`;
    await store.openConversation({
      adapter: 'rocketchat',
      externalId,
      shape: 'group',
      projectId,
    });
    const other = (
      await createTestProject(harness.db, ownerId, { slug: `gamma-${randomUUID().slice(0, 8)}` })
    ).id;

    await expect(
      collect.collectInboundMessage({
        ports: adapter({
          resolveVenue: async () => ({
            adapter: 'rocketchat' as const,
            externalId,
            shape: 'group' as const,
            projectId: other,
          }),
        }) as never,
        frame: { externalId, projectId: other, text: 'lost' },
        message: 'lost',
        speakerKey: 'rc-user-1',
        manySpeakersPrincipalUserId: ownerId,
      }),
    ).rejects.toThrow(/CONVERSATION_PROJECT_CONFLICT|is about/);

    const conversation = await store.findConversation('rocketchat', externalId);
    expect(await store.readMessages(conversation?.id as string, 10)).toEqual([]);
  });
});

// ISS-1086 — a room whose traffic never pauses still gets an answer.
describe('a window that never goes quiet is still due', () => {
  const T = () => new Date();
  const ago = (ms: number) => new Date(Date.now() - ms);
  const openAt = (seq: number, now: Date) =>
    windows.openOrExtendWindow({ conversationId, projectId, adapter: 'rocketchat', seq, now });
  const dueClaim = (over: Record<string, unknown> = {}) =>
    claim({ settleMs: 4000, holdMs: 15_000, now: T(), ...over });

  // cm:guard the red this issue was filed on: a window opened 20s ago and extended 1s ago satisfies neither `extended_at <= now - 4s` nor, before ISS-1086, anything else — and was never claimed (criterion 1).
  it('is claimed once it has been collecting longer than the hold, however recently it was extended (criterion 1)', async () => {
    await openAt(0, ago(20_000));
    await openAt(1, ago(1_000));
    const [taken] = await dueClaim();
    expect(taken).toBeDefined();
    expect(taken?.cutReason).toBe('deadline');
    expect(taken?.dueAt).toBeInstanceOf(Date);
  });

  it('is not claimed while it is younger than the hold and still being extended (criterion 2)', async () => {
    await openAt(0, ago(3_000));
    await openAt(1, ago(1_000));
    expect(await dueClaim()).toHaveLength(0);
  });

  it('carries quiet when the settle clock admitted it (criterion 3)', async () => {
    await openAt(0, ago(6_000));
    const [taken] = await dueClaim();
    expect(taken?.cutReason).toBe('quiet');
  });

  it('carries deadline when the hold admitted it (criterion 4)', async () => {
    await openAt(0, ago(16_000));
    await openAt(1, ago(500));
    const [taken] = await dueClaim();
    expect(taken?.cutReason).toBe('deadline');
  });

  // cm:guard re-claimed after the lease with `extended_at` now old enough to read as quiet: COALESCE is what keeps `deadline`, and without it the second claimant would tell the turn the room had finished speaking (criterion 5).
  it('keeps the first claim’s reason across a lease recovery (criterion 5)', async () => {
    await openAt(0, ago(16_000));
    await openAt(1, ago(500));
    const [first] = await dueClaim();
    expect(first?.cutReason).toBe('deadline');
    const [again] = await dueClaim({ leaseMs: 0, now: new Date(Date.now() + 10_000) });
    expect(again?.id).toBe(first?.id);
    expect(again?.cutReason).toBe('deadline');
  });

  it('reports when the window became due under the clocks the claim used', async () => {
    const opened = ago(16_000);
    await openAt(0, opened);
    await openAt(1, ago(500));
    const [taken] = await dueClaim();
    // due at opened + hold, because the settle clock had not admitted it
    expect(Math.abs((taken?.dueAt.getTime() ?? 0) - (opened.getTime() + 15_000))).toBeLessThan(50);
  });

  it('leaves the collecting index exactly as ISS-1004 defined it (criterion 17)', async () => {
    const rows = await harness.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'conversation_windows_one_collecting'`,
    );
    const def = (rows[0] as unknown as { indexdef: string }).indexdef;
    expect(def).toMatch(/UNIQUE INDEX/);
    expect(def).toMatch(/\(conversation_id\)/);
    expect(def).toMatch(/claimed_at IS NULL/);
    expect(def).toMatch(/closed_at IS NULL/);
  });
});

describe('a window that collected more than a turn may carry', () => {
  const ago = (ms: number) => new Date(Date.now() - ms);
  const openRange = async (first: number, last: number) => {
    await windows.openOrExtendWindow({
      conversationId,
      projectId,
      adapter: 'rocketchat',
      seq: first,
    });
    if (last > first)
      await windows.openOrExtendWindow({
        conversationId,
        projectId,
        adapter: 'rocketchat',
        seq: last,
      });
  };
  const rowsNow = async () =>
    (await harness.db.execute(
      sql`SELECT id, first_seq, last_seq, claimed_at, cut_reason, opened_at FROM conversation_windows WHERE conversation_id = ${conversationId} ORDER BY first_seq`,
    )) as unknown as {
      id: string;
      first_seq: number;
      last_seq: number;
      claimed_at: Date | null;
      cut_reason: string | null;
      opened_at: string;
    }[];

  it('keeps its head and leaves the tail in a new collecting window (criteria 11, 13)', async () => {
    await openRange(0, 59);
    const [taken] = await claim();
    const held = windows.claimOf(taken as never);
    expect(held).not.toBeNull();
    const firstAt = ago(20_000);
    expect(
      await windows.splitWindowTail({
        windowId: taken?.id as string,
        conversationId,
        projectId,
        adapter: 'rocketchat',
        claim: held as never,
        prefixLastSeq: 49,
        tail: { firstSeq: 50, lastSeq: 59, firstAt },
      }),
    ).toBe(true);
    const rows = await rowsNow();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ first_seq: 0, last_seq: 49, cut_reason: 'overflow' });
    expect(rows[0]?.claimed_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ first_seq: 50, last_seq: 59, cut_reason: null });
    expect(rows[1]?.claimed_at).toBeNull();
    // the tail has been waiting since its first message, so the successor's clocks start there
    // cm:guard `execute` hands back the driver's string for a timestamptz, not a Date: parse it before comparing.
    expect(Math.abs(new Date(rows[1]!.opened_at).getTime() - firstAt.getTime())).toBeLessThan(50);
  });

  // cm:guard the successor a mid-route message already opened ABSORBS the tail: two collecting windows for one room is what the partial index forbids, and the upsert lowers `first_seq` so the messages between the head and that successor are not left in neither (criterion 12).
  it('folds the tail into a collecting successor that already exists (criterion 12)', async () => {
    await openRange(0, 59);
    const [taken] = await claim();
    await openRange(60, 61);
    expect(await windowCount()).toBe(2);
    expect(
      await windows.splitWindowTail({
        windowId: taken?.id as string,
        conversationId,
        projectId,
        adapter: 'rocketchat',
        claim: windows.claimOf(taken as never) as never,
        prefixLastSeq: 49,
        tail: { firstSeq: 50, lastSeq: 59, firstAt: ago(20_000) },
      }),
    ).toBe(true);
    const rows = await rowsNow();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ first_seq: 50, last_seq: 61 });
    expect(rows[1]?.claimed_at).toBeNull();
  });

  it('writes nothing when the claim has moved on (criteria 23, 24)', async () => {
    await openRange(0, 59);
    const [taken] = await claim();
    expect(
      await windows.splitWindowTail({
        windowId: taken?.id as string,
        conversationId,
        projectId,
        adapter: 'rocketchat',
        claim: { claimedAt: taken?.claimedAt as Date, claimedBy: 'somebody-else' },
        prefixLastSeq: 49,
        tail: { firstSeq: 50, lastSeq: 59, firstAt: ago(20_000) },
      }),
    ).toBe(false);
    const rows = await rowsNow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ first_seq: 0, last_seq: 59, cut_reason: 'quiet' });
  });
});
