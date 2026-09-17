/**
 * ISS-1086 — a room whose traffic never pauses still gets an answer, against a
 * real Postgres. Split from `conversation-window-e2e.test.ts` for the file budget;
 * the harness is the same shape and the subject is the hold clock, the cut reason
 * a claim stamps, and the overflow split.
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

let harness: TestDatabase;
let store: typeof import('../../src/conversations/store.js');
let windows: typeof import('../../src/conversations/windows.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.NODE_ENV ??= 'test';
  store = await import('../../src/conversations/store.js');
  windows = await import('../../src/conversations/windows.js');
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

let projectId: string;
let conversationId: string;

beforeEach(async () => {
  await truncateAll(harness.db);
  const owner = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now()`);
  projectId = (
    await createTestProject(harness.db, owner.id, { slug: `alpha-${randomUUID().slice(0, 8)}` })
  ).id;
  const conversation = await store.openConversation({
    adapter: 'rocketchat',
    externalId: `chat.example.co ${randomUUID()}`,
    shape: 'group',
    projectId,
  });
  conversationId = conversation.id;
});

const ago = (ms: number) => new Date(Date.now() - ms);
const openAt = (seq: number, now: Date = new Date()) =>
  windows.openOrExtendWindow({ conversationId, projectId, adapter: 'rocketchat', seq, now });
const claim = (over: Record<string, unknown> = {}) =>
  windows.claimDueWindows({
    adapter: 'rocketchat',
    claimant: 'core-1',
    limit: 10,
    settleMs: 4000,
    holdMs: 15_000,
    ...over,
  } as never);

interface WindowRowSeen {
  id: string;
  first_seq: number;
  last_seq: number;
  claimed_at: string | null;
  cut_reason: string | null;
  opened_at: string;
  extended_at: string;
}
async function rowsNow(): Promise<WindowRowSeen[]> {
  const rows = await harness.db.execute(
    sql`SELECT id, first_seq, last_seq, claimed_at, cut_reason, opened_at, extended_at FROM conversation_windows WHERE conversation_id = ${conversationId} ORDER BY first_seq`,
  );
  return rows as unknown as WindowRowSeen[];
}

describe('a window that never goes quiet is still due', () => {
  // cm:guard the red this issue was filed on: a window opened 20s ago and extended 1s ago satisfies neither `extended_at <= now - 4s` nor, before ISS-1086, anything else — and was never claimed (criterion 1).
  it('is claimed once it has been collecting longer than the hold, however recently it was extended (criterion 1)', async () => {
    await openAt(0, ago(20_000));
    await openAt(1, ago(1_000));
    const [taken] = await claim();
    expect(taken).toBeDefined();
    expect(taken?.cutReason).toBe('deadline');
    expect(taken?.dueAt).toBeInstanceOf(Date);
  });

  it('is not claimed while it is younger than the hold and still being extended (criterion 2)', async () => {
    await openAt(0, ago(3_000));
    await openAt(1, ago(1_000));
    expect(await claim()).toHaveLength(0);
  });

  it('carries quiet when the settle clock admitted it (criterion 3)', async () => {
    await openAt(0, ago(6_000));
    const [taken] = await claim();
    expect(taken?.cutReason).toBe('quiet');
  });

  it('carries deadline when the hold admitted it (criterion 4)', async () => {
    await openAt(0, ago(16_000));
    await openAt(1, ago(500));
    const [taken] = await claim();
    expect(taken?.cutReason).toBe('deadline');
  });

  // cm:guard re-claimed after the lease with `extended_at` now old enough to read as quiet: COALESCE is what keeps `deadline`, and without it the second claimant would tell the turn the room had finished speaking (criterion 5).
  it('keeps the first claim’s reason across a lease recovery (criterion 5)', async () => {
    await openAt(0, ago(16_000));
    await openAt(1, ago(500));
    const [first] = await claim();
    expect(first?.cutReason).toBe('deadline');
    const [again] = await claim({ leaseMs: 0, now: new Date(Date.now() + 10_000) });
    expect(again?.id).toBe(first?.id);
    expect(again?.cutReason).toBe('deadline');
  });

  it('reports when the window became due under the clocks the claim used', async () => {
    const opened = ago(16_000);
    await openAt(0, opened);
    await openAt(1, ago(500));
    const [taken] = await claim();
    // due at opened + hold, because the settle clock had not admitted it
    expect(Math.abs((taken?.dueAt.getTime() ?? 0) - (opened.getTime() + 15_000))).toBeLessThan(50);
  });

  // cm:guard the interleaving whole-set review F1 named: while A is held, its quiet successor is NOT due, so no other core can answer a range A's split may still lower into (criterion 28).
  it('claims one conversation’s windows in the order they opened (criterion 28)', async () => {
    await openAt(0, ago(20_000));
    const [head] = await claim();
    expect(head?.firstSeq).toBe(0);
    await openAt(1, ago(6_000));
    expect(await claim()).toHaveLength(0);
    await windows.closeWindow({
      windowId: head?.id as string,
      decision: 'nothing-to-say',
      claim: { claimedAt: head?.claimedAt as Date, claimedBy: 'core-1' },
    });
    const [next] = await claim();
    expect(next?.firstSeq).toBe(1);
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
  const openRange = async (first: number, last: number) => {
    await openAt(first);
    if (last > first) await openAt(last);
  };
  const split = (
    taken: { id: string; claimedAt: Date | null } | undefined,
    claimedBy: string,
    firstAt: Date,
    lastAt: Date = ago(100),
  ) =>
    windows.splitWindowTail({
      windowId: taken?.id as string,
      conversationId,
      projectId,
      adapter: 'rocketchat',
      claim: { claimedAt: taken?.claimedAt as Date, claimedBy },
      prefixLastSeq: 49,
      tail: { firstSeq: 50, lastSeq: 59, firstAt, lastAt },
    });

  it('keeps its head and leaves the tail in a new collecting window (criteria 11, 13)', async () => {
    await openRange(0, 59);
    const [taken] = await claim({ settleMs: 0 });
    const firstAt = ago(20_000);
    expect(await split(taken, 'core-1', firstAt)).toBe(true);
    const rows = await rowsNow();
    expect(rows).toHaveLength(2);
    const [head, successor] = rows;
    expect(head).toMatchObject({ first_seq: 0, last_seq: 49, cut_reason: 'overflow' });
    expect(head?.claimed_at).not.toBeNull();
    expect(successor).toMatchObject({ first_seq: 50, last_seq: 59, cut_reason: null });
    expect(successor?.claimed_at).toBeNull();
    // the tail has been waiting since its first message, so the successor's clocks start there
    // cm:guard `execute` hands back the driver's string for a timestamptz, not a Date: parse it before comparing.
    expect(
      Math.abs(new Date(successor?.opened_at ?? 0).getTime() - firstAt.getTime()),
    ).toBeLessThan(50);
  });

  // cm:guard the successor a mid-route message already opened ABSORBS the tail: two collecting windows for one room is what the partial index forbids, and the upsert lowers `first_seq` so the messages between the head and that successor are not left in neither (criterion 12).
  it('folds the tail into a collecting successor that already exists (criterion 12)', async () => {
    await openRange(0, 59);
    const [taken] = await claim({ settleMs: 0 });
    await openRange(60, 61);
    expect(await rowsNow()).toHaveLength(2);
    expect(await split(taken, 'core-1', ago(20_000))).toBe(true);
    const rows = await rowsNow();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ first_seq: 50, last_seq: 61 });
    expect(rows[1]?.claimed_at).toBeNull();
  });

  // cm:guard whole-set review F2: a successor stamped with the tail's FIRST arrival reads as quiet the moment it exists, and a drain would answer it as `quiet` while the room was mid-sentence (criterion 29).
  it('starts the successor’s quiet clock at the tail’s last arrival, not its first (criterion 29)', async () => {
    await openRange(0, 59);
    const [taken] = await claim({ settleMs: 0 });
    const firstAt = ago(5_000);
    const lastAt = ago(100);
    expect(await split(taken, 'core-1', firstAt, lastAt)).toBe(true);
    await windows.closeWindow({
      windowId: taken?.id as string,
      decision: 'nothing-to-say',
      claim: { claimedAt: taken?.claimedAt as Date, claimedBy: 'core-1' },
    });
    const successor = (await rowsNow())[1];
    expect(
      Math.abs(new Date(successor?.extended_at ?? 0).getTime() - lastAt.getTime()),
    ).toBeLessThan(50);
    // neither quiet (100ms) nor past the hold (5s of 15s): not due
    expect(await claim()).toHaveLength(0);
    const [later] = await claim({ now: new Date(Date.now() + 4_500) });
    expect(later?.firstSeq).toBe(50);
    expect(later?.cutReason).toBe('quiet');
  });

  it('writes nothing when the claim has moved on (criteria 23, 24)', async () => {
    await openRange(0, 59);
    const [taken] = await claim({ settleMs: 0 });
    expect(await split(taken, 'somebody-else', ago(20_000))).toBe(false);
    const rows = await rowsNow();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ first_seq: 0, last_seq: 59, cut_reason: 'quiet' });
  });
});
