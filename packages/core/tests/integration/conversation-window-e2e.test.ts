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
    await windows.releaseWindow(claimed?.id as string);

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

    expect(await windows.closeWindow({ windowId: id, decision: 'guard-backoff' })).toMatchObject({
      decision: 'guard-backoff',
    });
    expect(await windows.closeWindow({ windowId: id, decision: 'answered' })).toBeNull();
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
    await windows.closeWindow({ windowId: one?.id as string, decision: 'nothing-to-say' });
    await open(1);
    const [two] = await claim();
    await windows.closeWindow({ windowId: two?.id as string, decision: 'answered' });

    expect((await windows.recentDecisions(conversationId)).map((d) => d.decision)).toEqual([
      'answered',
      'nothing-to-say',
    ]);
  });
});

describe('a window is delivered at most once', () => {
  it('finds the reply that already carries its key', async () => {
    await open(0);
    const [claimed] = await claim();
    const key = windows.windowDeliveryKey(claimed?.id as string);

    expect(await store.deliveredUnderKey(conversationId, key)).toBe(false);
    await store.appendMessage({
      conversationId,
      role: 'assistant',
      content: 'an answer',
      deliveryProof: { messageId: 'rc-9', deliveryKey: key },
    });
    expect(await store.deliveredUnderKey(conversationId, key)).toBe(true);
  });

  it(`does not confuse one window reply for another`, async () => {
    await open(0);
    const [claimed] = await claim();
    await store.appendMessage({
      conversationId,
      role: 'assistant',
      content: 'an answer',
      deliveryProof: { deliveryKey: windows.windowDeliveryKey(claimed?.id as string) },
    });
    expect(await store.deliveredUnderKey(conversationId, 'window:somebody-else')).toBe(false);
  });

  it('records the reservation before the send, and leaves it readable afterwards', async () => {
    await open(0);
    const [claimed] = await claim();
    await windows.reserveDelivery(claimed?.id as string);
    expect((await windows.getWindow(claimed?.id as string))?.deliveryReservedAt).toBeInstanceOf(
      Date,
    );
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
