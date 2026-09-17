/**
 * What a claimed window decides, and what it writes down.
 *
 * The store, the guards and the turn are stubbed: what is under test is the
 * mapping from a turn's outcome to the decision the window closes under, which
 * is the record a person reads when they ask why nothing was said.
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
const { BACKOFF_AFTER, DORMANT_MS, LOOP_BOUNCE_MS, LOOP_LIMIT } = await import('./proactivity.js');

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

describe('every ending closes the window under a decision', () => {
  it('answers', async () => {
    await expect(route()).resolves.toMatchObject({ decision: 'answered' });
    expect(closeWindow).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'w1', decision: 'answered' }),
    );
  });

  it('records a declined turn as nothing-to-say', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'declined', reason: 'nothing-to-say' });
    await expect(route()).resolves.toMatchObject({ decision: 'nothing-to-say' });
  });

  it('records the guard that stopped it, and takes no turn', async () => {
    verdict = { speak: false, decision: 'guard-backoff', detail: { consecutiveQuietWindows: 3 } };
    await expect(route()).resolves.toMatchObject({ decision: 'guard-backoff' });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  // cm:guard the close is the function's POST-CONDITION and not a step in its happy path: a window left open under a lapsed claim is re-claimed and routed again, which is the double answer the claim exists to prevent (ISS-1004 rule 1).
  it('closes the window even when routing throws', async () => {
    runConversationTurn.mockRejectedValue(new Error('provider exploded'));
    await expect(route()).resolves.toMatchObject({ decision: 'unreachable' });
    expect(closeWindow).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'w1', decision: 'unreachable' }),
    );
  });
});

describe('an outcome nobody knows yet', () => {
  // cm:guard a DIVERTED turn is `handed-off` and not `undetermined`, and the difference is what is
  // known: `undetermined` says a delivery was started and nobody recorded how it ended, while this
  // says a session on a box is still writing the answer. The Forge UI prints the first as "a reply
  // was sent and never confirmed", which was a false sentence under every live Agent turn until
  // ISS-1039 split them.
  it('records a diverted turn as handed-off', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'diverted', reason: 'agent-turn-dispatched' });
    await expect(route()).resolves.toMatchObject({ decision: 'handed-off' });
  });

  // cm:guard the recovery half, and the case that reds if `handoffFor` is dropped: a core that died
  // between the dispatch and the close leaves a reservation and no delivered row, which this module
  // alone cannot tell from a lost delivery. Without the probe the window reopens `undetermined` and
  // the thread says a reply was sent, about an answer nobody had written (ISS-1039, consult F5).
  it('reads a reservation left by a handoff as handed-off, and dispatches nothing more', async () => {
    const outcome = await routeWindow({
      window: { ...WINDOW, deliveryReservedAt: new Date('2026-09-16T20:00:00.000Z') },
      manySpeakersPrincipalUserId: 'principal-1',
      handoffFor: async () => ({ sessionId: 'session-9' }),
      inputs: () => ({ door: 'chat-sync', handleName: 'Babo' }),
    });
    expect(outcome).toMatchObject({
      decision: 'handed-off',
      detail: { sessionId: 'session-9' },
    });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  // cm:guard the other side of the same read: with no handoff behind it, a reservation is exactly
  // what it always was, and widening `handed-off` to cover it would tell a person a session is
  // writing an answer that nothing is writing.
  it('still records a reservation with no handoff behind it as undetermined', async () => {
    const outcome = await routeWindow({
      window: { ...WINDOW, deliveryReservedAt: new Date('2026-09-16T20:00:00.000Z') },
      manySpeakersPrincipalUserId: 'principal-1',
      handoffFor: async () => null,
      inputs: () => ({ door: 'chat-sync', handleName: 'Babo' }),
    });
    expect(outcome).toMatchObject({ decision: 'undetermined' });
  });

  // cm:guard an `undeliverable` transport error is `undetermined` and NOT `unreachable`: a POST that timed out may have been accepted before the socket went, and calling that a failure is the misclassification rule 4 forbids (ISS-1004 review F3).
  it('records a delivery that was attempted and did not report back as undetermined', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'undeliverable', reason: 'socket hang up' });
    await expect(route()).resolves.toMatchObject({
      decision: 'undetermined',
      detail: { attempted: true },
    });
  });

  it('keeps unreachable for what it knows before anything was sent', async () => {
    conversationRow = null;
    await expect(route()).resolves.toMatchObject({ decision: 'unreachable' });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });
});

describe('a window is delivered at most once', () => {
  it('takes no turn when the reply already carries this window key', async () => {
    delivered = true;
    await expect(route()).resolves.toMatchObject({ decision: 'answered' });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  // cm:guard a reservation with no delivered row is the fourth state and NOT a licence to try again: the previous holder handed the text to the transport and died before it could say how that went (ISS-1004 review F2).
  it('sends nothing when a delivery was reserved and never reported', async () => {
    await expect(route({ deliveryReservedAt: new Date() })).resolves.toMatchObject({
      decision: 'undetermined',
    });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it('hands the turn a key derived from the window, and the reservation hook', async () => {
    await route();
    const req = runConversationTurn.mock.calls[0]?.[0] as {
      deliveryKey: string;
      onBeforeDeliver: () => Promise<void>;
      questionAlreadyRecorded: boolean;
      mayDecline: boolean;
    };
    expect(req.deliveryKey).toBe('window:w1');
    expect(req.questionAlreadyRecorded).toBe(true);
    expect(req.mayDecline).toBe(true);
    await req.onBeforeDeliver();
    expect(reserveDelivery).toHaveBeenCalledWith('w1', {
      claimedAt: expect.any(Date),
      claimedBy: 'core-1',
    });
  });
});

describe('authority', () => {
  it('runs a one-to-one room as the speaker the collector resolved', async () => {
    conversationRow = { ...conversation, shape: 'direct' };
    await route();
    expect(runConversationTurn.mock.calls[0]?.[0]).toMatchObject({
      principalUserId: 'speaker-1',
    });
  });

  // cm:guard the refusal is DELIVERED, reserved first and written to the transcript under the window's key: `authority-refused` used to be a decision nobody outside the database could read, so a person whose synchronous refusal failed to send got silence (review pass 1 F3).
  it('refuses a one-to-one room whose speaker is linked to nobody, and says so in the room', async () => {
    conversationRow = { ...conversation, shape: 'direct' };
    messageRows = messages.map((m) => ({ ...m, authorUserId: null }));
    await expect(route()).resolves.toMatchObject({
      decision: 'authority-refused',
      detail: { told: true },
    });
    expect(runConversationTurn).not.toHaveBeenCalled();
    expect(reserveDelivery).toHaveBeenCalledBefore(deliver);
    const recorded = recordDeliveredReply.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(recorded).toMatchObject({ deliveryKey: 'window:w1' });
  });

  it('says nothing and takes no decision when the claim moved on mid-refusal', async () => {
    conversationRow = { ...conversation, shape: 'direct' };
    messageRows = messages.map((m) => ({ ...m, authorUserId: null }));
    reserveDelivery.mockResolvedValueOnce(false);
    await expect(route()).resolves.toMatchObject({ decision: 'undetermined' });
    expect(deliver).not.toHaveBeenCalled();
  });

  // cm:guard a refusal the door would not take is `undetermined` and not `authority-refused`: the window records that nobody was told, and the reservation stops the next claim saying it twice (rule 4).
  // cm:guard a wording lookup that failed must leave the window claimable rather than reserved: `refusalFor` asks a directory, and a reservation burned by a lookup that sent nothing would leave the person never told (review of the plan, F1).
  it('leaves the window unreserved when the refusal wording cannot be looked up', async () => {
    conversationRow = { ...conversation, shape: 'direct' };
    messageRows = messages.map((m) => ({ ...m, authorUserId: null }));
    await expect(
      routeWindow({
        window: { ...WINDOW },
        manySpeakersPrincipalUserId: 'principal-1',
        inputs: () => ({ door: 'chat-sync', handleName: 'Babo' }),
        refusalFor: async () => {
          throw new Error('the directory is down');
        },
      }),
    ).resolves.toMatchObject({ decision: 'unreachable' });
    expect(reserveDelivery).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  // cm:guard the proof carries WHICH decision sent it, so a crash between the refusal and the close cannot be recovered as an ordinary answer (review of the plan, F1).
  it('recovers a delivered refusal as authority-refused and not as answered', async () => {
    conversationRow = { ...conversation, shape: 'direct' };
    messageRows = messages.map((m) => ({ ...m, authorUserId: null }));
    await route();
    const recorded = recordDeliveredReply.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(recorded.decision).toBe('authority-refused');
  });

  it('does not claim to have refused when the door would not take it', async () => {
    conversationRow = { ...conversation, shape: 'direct' };
    messageRows = messages.map((m) => ({ ...m, authorUserId: null }));
    deliver.mockRejectedValueOnce(new Error('room is gone'));
    await expect(route()).resolves.toMatchObject({
      decision: 'undetermined',
      detail: { told: false, attempted: true },
    });
    expect(recordDeliveredReply).not.toHaveBeenCalled();
  });

  it('runs a many-speaker room as the binding principal', async () => {
    await route();
    expect(runConversationTurn.mock.calls[0]?.[0]).toMatchObject({
      principalUserId: 'principal-1',
    });
  });
});

// cm:guard the speaker is asserted DISTINCT from the principal in a room, because in a direct venue the two are the same id and a test there would pass with the speaker read off the principal — the very substitution that would style every room reply for the org agent (ISS-1034 criterion 19).
describe('whose preferences a room reply honours', () => {
  it('names the newest linked person as the speaker while the room runs as the principal', async () => {
    const inputs = vi.fn((_c: WindowContext) => ({
      door: 'chat-sync' as const,
      handleName: 'Babo',
    }));
    await routeWindow({ window: WINDOW, manySpeakersPrincipalUserId: 'principal-1', inputs });
    expect(runConversationTurn.mock.calls[0]?.[0]).toMatchObject({
      principalUserId: 'principal-1',
      speakerUserId: 'speaker-1',
      handleUserId: 'handle-1',
    });
    expect(inputs.mock.calls[0]?.[0]).toMatchObject({ speakerUserId: 'speaker-1' });
  });

  it('passes a null speaker, not the principal, when the newest person is linked to nobody', async () => {
    messageRows = messages.map((m) => ({ ...m, authorUserId: null }));
    await route();
    expect(runConversationTurn.mock.calls[0]?.[0]).toMatchObject({
      principalUserId: 'principal-1',
      speakerUserId: null,
    });
  });
});

describe('the room’s presence reaches the guards', () => {
  it('folds a room with no self onto today’s constants (criterion 32)', async () => {
    await route();
    expect(decideProactivity.mock.calls[0]?.[0]).toMatchObject({
      conversationId: 'c1',
      thresholds: {
        dormantMs: DORMANT_MS,
        backoffAfter: BACKOFF_AFTER,
        loopBounceMs: LOOP_BOUNCE_MS,
        loopLimit: LOOP_LIMIT,
      },
    });
  });

  it('passes a handle’s own numbers through (criterion 33)', async () => {
    selves = new Map([['handle-1', { presence: { backoffAfter: 1 } }]]);
    await route();
    expect(decideProactivity.mock.calls[0]?.[0]).toMatchObject({
      thresholds: { backoffAfter: 1, loopLimit: LOOP_LIMIT },
    });
  });

  // cm:guard the second handle has NO self row and still counts: its default joins the fold, so one handle's longer bounce is capped back to the default by the handle that never wrote one (codex F4).
  it('folds a handle with no self row as the defaults, not as absent', async () => {
    handles.push({ userId: 'handle-2', handle: 'nabo' });
    selves = new Map([['handle-1', { presence: { loopBounceMs: 60_000 } }]]);
    try {
      await route();
      expect(decideProactivity.mock.calls[0]?.[0]).toMatchObject({
        thresholds: { loopBounceMs: LOOP_BOUNCE_MS },
      });
    } finally {
      handles.pop();
    }
  });
});

// cm:guard the three rows are one rule read from three sides — gated, let through, not gated — and the direct case is the one that would pass by accident if `mention` were applied to every venue: a direct room's one person names nobody and is still owed every answer (ISS-1034 criteria 66-68).
describe('answerInGroup: mention', () => {
  const mention = () => {
    selves = new Map([['handle-1', { presence: { answerInGroup: 'mention' } }]]);
  };

  it('decides nothing-to-say with detail not-mentioned when no message names the handle', async () => {
    mention();
    await expect(route()).resolves.toEqual({
      decision: 'nothing-to-say',
      detail: { reason: 'not-mentioned', handles: ['babo'] },
    });
    expect(runConversationTurn).not.toHaveBeenCalled();
    expect(decideProactivity).not.toHaveBeenCalled();
  });

  it('routes normally when a message in the window names the handle', async () => {
    mention();
    messageRows = messages.map((m) => ({ ...m, content: '@Babo why is CI red?' }));
    await expect(route()).resolves.toMatchObject({ decision: 'answered' });
    expect(runConversationTurn).toHaveBeenCalled();
  });

  it('answers a direct room whatever the mode says', async () => {
    mention();
    conversationRow = { ...conversation, shape: 'direct' };
    await expect(route()).resolves.toMatchObject({ decision: 'answered' });
  });
});

// ISS-1086 — what a turn is told about the window it answers, and what every close measures.
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
        tail: { firstSeq: 54, lastSeq: 56, firstAt: new Date(1_700_000_000_000 + 50 * 1000) },
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
