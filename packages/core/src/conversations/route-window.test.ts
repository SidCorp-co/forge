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
  readMessagesInRange: async (_id: string, r: { firstSeq: number; lastSeq: number }) =>
    messageRows.filter((m) => m.seq >= r.firstSeq && m.seq <= r.lastSeq),
  deliveredDecisionUnderKey: async () => (delivered ? 'answered' : null),
  assistantSentExternalIds: async () => new Set<string>(),
  effectiveConversationMode: (row: { mode: 'assistant' | 'agent' | null }) =>
    row.mode ?? 'assistant',
}));

const closeWindow = vi.fn(async () => null);
const reserveDelivery = vi.fn(async () => true);
vi.mock('./windows.js', () => ({
  windowDeliveryKey: (id: string) => `window:${id}`,
  claimOf: (row: { claimedAt: Date | null; claimedBy: string | null }) =>
    row.claimedAt && row.claimedBy ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy } : null,
  closeWindow: (...a: unknown[]) => closeWindow(...(a as [])),
  reserveDelivery: (...a: unknown[]) => reserveDelivery(...(a as [])),
  splitWindowTail: async () => true,
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
  personCount: async () => 1,
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

const route = (over: Partial<typeof WINDOW> = {}) =>
  routeWindow({
    window: { ...WINDOW, ...over },
    manySpeakersPrincipalUserId: 'principal-1',
    inputs: () => ({ door: 'chat-sync', handleName: 'Babo' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  conversationRow = conversation;
  messageRows = messages;
  delivered = false;
  verdict = { speak: true };
  selves = new Map();
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

  it('closes the window even when routing throws', async () => {
    runConversationTurn.mockRejectedValue(new Error('provider exploded'));
    await expect(route()).resolves.toMatchObject({ decision: 'unreachable' });
    expect(closeWindow).toHaveBeenCalledWith(
      expect.objectContaining({ windowId: 'w1', decision: 'unreachable' }),
    );
  });
});

describe('an outcome nobody knows yet', () => {
  it('records a diverted turn as handed-off', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'diverted', reason: 'agent-turn-dispatched' });
    await expect(route()).resolves.toMatchObject({ decision: 'handed-off' });
  });

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

  it('still records a reservation with no handoff behind it as undetermined', async () => {
    const outcome = await routeWindow({
      window: { ...WINDOW, deliveryReservedAt: new Date('2026-09-16T20:00:00.000Z') },
      manySpeakersPrincipalUserId: 'principal-1',
      handoffFor: async () => null,
      inputs: () => ({ door: 'chat-sync', handleName: 'Babo' }),
    });
    expect(outcome).toMatchObject({ decision: 'undetermined' });
  });

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
