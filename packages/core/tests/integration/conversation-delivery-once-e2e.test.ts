/**
 * ISS-1004 — a window's reply reaches the room once, against a real Postgres.
 *
 * The at-most-once property is the one this table was added for, and it is made
 * of three rows and no code: the delivery key on a reply's proof, the
 * reservation stamped before the send, and the claim generation that decides
 * which of two holders may write either. Split from
 * `conversation-window-e2e.test.ts` to keep both inside the size budget.
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

const open = (seq: number) =>
  windows.openOrExtendWindow({ conversationId, projectId, adapter: 'rocketchat', seq });

const claim = (over: Record<string, unknown> = {}) =>
  windows.claimDueWindows({
    adapter: 'rocketchat',
    claimant: 'core-1',
    limit: 10,
    settleMs: 0,
    ...over,
  } as never);

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

  it('remembers which decision a delivery was, and defaults to answered when it says none', async () => {
    await open(0);
    const [claimed] = await claim();
    const key = windows.windowDeliveryKey(claimed?.id as string);

    await store.appendMessage({
      conversationId,
      role: 'assistant',
      content: 'nobody here to answer as',
      deliveryProof: { messageId: 'rc-9', deliveryKey: key, decision: 'authority-refused' },
    });
    expect(await store.deliveredDecisionUnderKey(conversationId, key)).toBe('authority-refused');

    const plain = 'window:an-ordinary-answer';
    await store.appendMessage({
      conversationId,
      role: 'assistant',
      content: 'an answer',
      deliveryProof: { messageId: 'rc-10', deliveryKey: plain },
    });
    expect(await store.deliveredDecisionUnderKey(conversationId, plain)).toBe('answered');
    expect(await store.deliveredDecisionUnderKey(conversationId, 'window:never')).toBeNull();
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
    const held = windows.claimOf(claimed as never) as never;
    expect(await windows.reserveDelivery(claimed?.id as string, held)).toBe(true);
    expect((await windows.getWindow(claimed?.id as string))?.deliveryReservedAt).toBeInstanceOf(
      Date,
    );
  });

  it('refuses the reservation, the close and the release to a holder whose claim moved on', async () => {
    await open(0);
    const [first] = await claim();
    const stale = windows.claimOf(first as never) as never;

    const [second] = await claim({ claimant: 'core-2', leaseMs: 0 });
    expect(second?.id).toBe(first?.id);
    const live = windows.claimOf(second as never) as never;

    expect(await windows.reserveDelivery(first?.id as string, stale)).toBe(false);
    expect((await windows.getWindow(first?.id as string))?.deliveryReservedAt).toBeNull();

    expect(
      await windows.closeWindow({
        windowId: first?.id as string,
        decision: 'answered',
        claim: stale,
      }),
    ).toBeNull();
    expect((await windows.getWindow(first?.id as string))?.closedAt).toBeNull();

    await windows.releaseWindow(first?.id as string, stale);
    expect((await windows.getWindow(first?.id as string))?.claimedBy).toBe('core-2');

    expect(await windows.reserveDelivery(first?.id as string, live)).toBe(true);
    expect(
      await windows.closeWindow({
        windowId: first?.id as string,
        decision: 'answered',
        claim: live,
      }),
    ).toMatchObject({ decision: 'answered' });
  });

  it('lets the holder that owns the claim reserve more than once', async () => {
    await open(0);
    const [claimed] = await claim();
    const held = windows.claimOf(claimed as never) as never;
    expect(await windows.reserveDelivery(claimed?.id as string, held)).toBe(true);
    expect(await windows.reserveDelivery(claimed?.id as string, held)).toBe(true);
  });
});
