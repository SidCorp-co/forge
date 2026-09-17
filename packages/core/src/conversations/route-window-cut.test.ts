/**
 * ISS-1086 — what a turn is told about the window it answers, and what every
 * close measures. Split from `route-window.test.ts` for the file budget; the
 * mocks are the same shape, and the subject is the cut, the overflow split and
 * the three durations rather than the decision vocabulary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowContext } from './route-window.js';

const conversation = {
  id: 'c1',
  adapter: 'rocketchat' as const,
  externalId: 'chat.example.co room-1',
  shape: 'group' as 'group' | 'direct',
  title: null as string | null,
};
let conversationRow: typeof conversation | null = conversation;
let delivered = false;
const messages = [
  {
    id: 'm1',
    seq: 4,
    role: 'user' as const,
    authorUserId: 'speaker-1' as string | null,
    authorLabel: 'alice',
    externalId: 'rc-1',
    content: 'why is CI red?',
    images: [],
    deliveryProof: null,
    silenceReason: null,
    createdAt: new Date(),
  },
];
let messageRows = messages;

vi.mock('./store.js', () => ({
  getConversation: async () => conversationRow,
  readMessages: async () => messageRows,
  // cm:guard honours `limit` and `order` like the real one, because the overflow branch reads one past the cap oldest-first and a mock returning the whole range would never let it see a cap (ISS-1086 criterion 10).
  readMessagesInRange: async (
    _id: string,
    r: { firstSeq: number; lastSeq: number; limit: number; order?: string },
  ) => {
    const inRange = messageRows
      .filter((m) => m.seq >= r.firstSeq && m.seq <= r.lastSeq)
      .sort((x, y) => x.seq - y.seq);
    return r.order === 'oldest-first' ? inRange.slice(0, r.limit) : inRange.slice(-r.limit);
  },
  deliveredDecisionUnderKey: async () => (delivered ? 'answered' : null),
  // cm:guard the REAL reading and not a stub: what a null mode means is the claim this module now
  // forks on, so a mock returning a fixed answer would make every case below say nothing about it.
  effectiveConversationMode: (row: { mode: 'assistant' | 'agent' | null }) =>
    row.mode ?? 'assistant',
}));

const closeWindow = vi.fn(async () => null);
const reserveDelivery = vi.fn(async () => true);
const splitWindowTail = vi.fn(async (_args?: unknown) => true);
vi.mock('./windows.js', () => ({
  windowDeliveryKey: (id: string) => `window:${id}`,
  claimOf: (row: { claimedAt: Date | null; claimedBy: string | null }) =>
    row.claimedAt && row.claimedBy ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy } : null,
  closeWindow: (...a: unknown[]) => closeWindow(...(a as [])),
  reserveDelivery: (...a: unknown[]) => reserveDelivery(...(a as [])),
  splitWindowTail: (...a: unknown[]) => splitWindowTail(a[0]),
}));

const deliver = vi.fn(async () => ({ messageId: 'rc-9' }));
vi.mock('./ports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ports.js')>()),
  conversationTransport: () => ({ deliver: (...a: unknown[]) => deliver(...(a as [])) }),
}));

const recordDeliveredReply = vi.fn(async (_reply?: unknown) => undefined);
vi.mock('./transcript.js', () => ({
  recordDeliveredReply: (...a: unknown[]) => recordDeliveredReply(...(a as [])),
}));

let verdict: unknown = { speak: true };
const decideProactivity = vi.fn(async (_input: unknown) => verdict);
// cm:guard `decideProactivity` alone is replaced and the module's constants stay real, because `presence.js` folds a room with no self onto those constants — a whole-module mock would fold onto `undefined` and the pass-through assertions below would compare nothing with nothing (ISS-1034 criterion 32).
vi.mock('./proactivity.js', async (orig) => ({
  ...(await orig<typeof import('./proactivity.js')>()),
  decideProactivity: (...a: unknown[]) => decideProactivity(a[0]),
}));
vi.mock('../config/env.js', () => ({ env: {} }));
vi.mock('../db/client.js', () => ({ db: {} }));
const handles = [{ userId: 'handle-1', handle: 'babo' }];
vi.mock('./participants.js', () => ({
  roomHandles: async () => handles,
  handleForProject: async () => 'handle-1',
}));
let selves = new Map<string, { presence: Record<string, unknown> }>();
vi.mock('../orgs/agent-selves.js', () => ({ readSelvesFor: async () => selves }));

const runConversationTurn = vi.fn();
vi.mock('./turn-runner.js', () => ({
  runConversationTurn: (...a: unknown[]) => runConversationTurn(...(a as [])),
}));

const { routeWindow } = await import('./route-window.js');

const WINDOW = {
  id: 'w1',
  conversationId: 'c1',
  projectId: 'p1',
  adapter: 'rocketchat' as const,
  openedAt: new Date(),
  extendedAt: new Date(),
  firstSeq: 4,
  lastSeq: 4,
  claimedAt: new Date(),
  claimedBy: 'core-1',
  cutReason: null as 'quiet' | 'deadline' | 'overflow' | null,
  deliveryReservedAt: null as Date | null,
  closedAt: null,
  decision: null,
  decisionDetail: null,
};

const inputs = vi.fn((_ctx?: WindowContext) => ({
  door: 'chat-sync' as const,
  handleName: 'Babo',
}));
const route = (over: Partial<typeof WINDOW> & { dueAt?: Date } = {}) =>
  routeWindow({
    window: { ...WINDOW, ...over },
    manySpeakersPrincipalUserId: 'principal-1',
    inputs: (ctx) => inputs(ctx),
  });
const contextGiven = () => inputs.mock.calls[0]?.[0] as WindowContext;
const closeDetail = () =>
  (closeWindow.mock.calls[0] as unknown as [{ detail: Record<string, unknown> }])[0].detail;

beforeEach(() => {
  vi.clearAllMocks();
  conversationRow = conversation;
  messageRows = messages;
  delivered = false;
  verdict = { speak: true };
  selves = new Map();
  splitWindowTail.mockResolvedValue(true);
  runConversationTurn.mockResolvedValue({ kind: 'delivered', messageId: 'rc-9' });
});

describe('the cut a window was claimed under', () => {
  it('reaches the adapter with the covered range and the snapshot time (criteria 6, 7, 8)', async () => {
    const claimedAt = new Date('2026-09-17T12:00:00Z');
    await route({ cutReason: 'deadline', claimedAt, firstSeq: 4, lastSeq: 4 });
    expect(contextGiven().cut).toEqual({
      reason: 'deadline',
      coveredSeq: [4, 4],
      snapshotAt: claimedAt,
    });
  });

  // cm:guard the one absorb, and it is asserted rather than left to a default: a row claimed before the column existed carries null and reads as quiet, which is what every such window was before ISS-1086.
  it('reads a row claimed before the column as quiet', async () => {
    await route({ cutReason: null });
    expect(contextGiven().cut.reason).toBe('quiet');
  });

  it('writes the cut and the three durations into every close (criteria 9, 25, 26, 27)', async () => {
    const openedAt = new Date('2026-09-17T12:00:00Z');
    const dueAt = new Date('2026-09-17T12:00:15Z');
    const claimedAt = new Date('2026-09-17T12:00:16Z');
    await route({ cutReason: 'deadline', openedAt, dueAt, claimedAt });
    const detail = closeDetail();
    expect(detail.cut).toBe('deadline');
    expect(detail.coveredSeq).toEqual([4, 4]);
    expect(detail.collectedMs).toBe(16_000);
    expect(detail.routingDelayMs).toBe(1_000);
    expect(typeof detail.replyMs).toBe('number');
  });

  // cm:guard a duration nobody measured is null and never zero: a caller whose row carries no `dueAt` has not said when the window became due, and a zero there would read as a drain that was never late.
  it('leaves routingDelayMs null where the row carries no dueAt', async () => {
    await route({ cutReason: 'quiet' });
    expect(closeDetail().routingDelayMs).toBeNull();
  });

  it('names the cut even when routing threw', async () => {
    conversationRow = null;
    await route({ cutReason: 'deadline' });
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(closeDetail().cut).toBe('deadline');
  });
});

describe('a window over the message cap', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...(messages[0] as (typeof messages)[number]),
      id: `m${i}`,
      seq: 4 + i,
      externalId: `rc-${i}`,
      content: `message ${i}`,
      createdAt: new Date(1_700_000_000_000 + i * 1000),
    }));

  it('hands the turn the oldest fifty and splits the tail off under the claim (criteria 10, 13)', async () => {
    messageRows = many(53);
    await route({ cutReason: 'deadline', firstSeq: 4, lastSeq: 56 });
    const ctx = contextGiven();
    expect(ctx.messages).toHaveLength(50);
    expect(ctx.messages[0]?.seq).toBe(4);
    expect(ctx.messages[49]?.seq).toBe(53);
    expect(ctx.cut).toMatchObject({ reason: 'overflow', coveredSeq: [4, 53] });
    expect(splitWindowTail).toHaveBeenCalledWith(
      expect.objectContaining({
        windowId: 'w1',
        prefixLastSeq: 53,
        // the successor's quiet clock is the window's own `extendedAt`, its last arrival (criterion 29)
        tail: {
          firstSeq: 54,
          lastSeq: 56,
          firstAt: new Date(1_700_000_000_000 + 50 * 1000),
          lastAt: WINDOW.extendedAt,
        },
      }),
    );
    expect(closeDetail()).toMatchObject({ cut: 'overflow', coveredSeq: [4, 53] });
  });

  it('does not split a window at exactly the cap', async () => {
    messageRows = many(50);
    await route({ firstSeq: 4, lastSeq: 53 });
    expect(splitWindowTail).not.toHaveBeenCalled();
    expect(contextGiven().messages).toHaveLength(50);
  });

  // cm:guard a false split is another holder's window: no turn and no close from this one, which is the double reply the claim exists to prevent (criteria 23, 24).
  it('takes no turn and closes nothing when the split finds the claim moved on (criteria 23, 24)', async () => {
    messageRows = many(53);
    splitWindowTail.mockResolvedValueOnce(false);
    await expect(route({ firstSeq: 4, lastSeq: 56 })).resolves.toMatchObject({
      decision: 'undetermined',
      superseded: true,
    });
    expect(runConversationTurn).not.toHaveBeenCalled();
    expect(inputs).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });
});
