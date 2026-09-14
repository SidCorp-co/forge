/**
 * What a claimed window decides, and what it writes down.
 *
 * The store, the guards and the turn are stubbed: what is under test is the
 * mapping from a turn's outcome to the decision the window closes under, which
 * is the record a person reads when they ask why nothing was said.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

const closeWindow = vi.fn(async () => null);
const reserveDelivery = vi.fn(async () => true);
vi.mock('./windows.js', () => ({
  windowDeliveryKey: (id: string) => `window:${id}`,
  claimOf: (row: { claimedAt: Date | null; claimedBy: string | null }) =>
    row.claimedAt && row.claimedBy ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy } : null,
  closeWindow: (...a: unknown[]) => closeWindow(...(a as [])),
  reserveDelivery: (...a: unknown[]) => reserveDelivery(...(a as [])),
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
vi.mock('./proactivity.js', () => ({
  decideProactivity: async () => verdict,
}));

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
  it('records a diverted turn as undetermined', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'diverted', reason: 'agent-chat-dispatched' });
    await expect(route()).resolves.toMatchObject({ decision: 'undetermined' });
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
