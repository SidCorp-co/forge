/**
 * ISS-1088 — what a window that is somebody asking is owed beside its answer:
 * a receipt while the turn runs, and one status when the answer did not land.
 *
 * The store, the guards and the turn are stubbed as in `route-window.test.ts`;
 * what is under test is when the acknowledgement starts and stops, which
 * decisions post a status, where it goes, and whom the reply addresses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../observability/sentry.js', () => ({ Sentry: { captureException: vi.fn() } }));
const loggerError = vi.fn();
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: (...a: unknown[]) => loggerError(...a),
  },
}));

const conversation = {
  id: 'c1',
  adapter: 'rocketchat' as const,
  externalId: 'chat.example.co ROOM1',
  shape: 'group' as 'group' | 'direct',
  title: null as string | null,
  presence: null,
  mode: null,
};
let conversationRow: typeof conversation | null = conversation;
const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);
const msg = (over: Record<string, unknown>) => ({
  id: 'm1',
  seq: 4,
  role: 'user' as const,
  authorUserId: null as string | null,
  authorLabel: 'alice',
  authorKey: 'u-alice',
  externalId: 'rc-1',
  replyToExternalId: null as string | null,
  content: '@babo why is CI red?',
  blocks: null,
  images: [],
  deliveryProof: null,
  silenceReason: null,
  createdAt: at(7),
  ...over,
});
let messageRows = [msg({})];
let sentByHandle = new Set<string>();

vi.mock('./store.js', () => ({
  getConversation: async () => conversationRow,
  readMessagesInRange: async (_id: string, r: { firstSeq: number; lastSeq: number }) =>
    messageRows.filter((m) => m.seq >= r.firstSeq && m.seq <= r.lastSeq),
  deliveredDecisionUnderKey: async () => null,
  assistantSentExternalIds: async () => sentByHandle,
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

const deliver = vi.fn(async (..._a: unknown[]) => ({ messageId: 'rc-status-1' }));
const acks: unknown[] = [];
const acknowledge = vi.fn(async (_venue: unknown, ack: unknown) => {
  acks.push(ack);
});
let transport: Record<string, unknown> | undefined = {};
vi.mock('./ports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ports.js')>()),
  conversationTransport: () => transport,
}));

const recordDeliveredReply = vi.fn(async (_reply?: unknown) => undefined);
vi.mock('./transcript.js', () => ({
  recordDeliveredReply: (...a: unknown[]) => recordDeliveredReply(...(a as [])),
}));

let verdict: unknown = { speak: true };
vi.mock('./proactivity.js', async (orig) => ({
  ...(await orig<typeof import('./proactivity.js')>()),
  decideProactivity: async () => verdict,
}));
vi.mock('../config/env.js', () => ({ env: {} }));
vi.mock('../db/client.js', () => ({ db: {} }));
let people = 2;
vi.mock('./participants.js', () => ({
  roomHandles: async () => [{ userId: 'handle-1', handle: 'babo' }],
  handleForProject: async () => 'handle-1',
  personCount: async () => people,
}));
vi.mock('../orgs/agent-selves.js', () => ({ readSelvesFor: async () => new Map() }));

const runConversationTurn = vi.fn();
vi.mock('./turn-runner.js', () => ({
  runConversationTurn: (...a: unknown[]) => runConversationTurn(...(a as [])),
}));

const { routeWindow } = await import('./route-window.js');
const { nothingPostedStatus, uncertainStatus } = await import('./fallback-replies.js');

const WINDOW = {
  id: 'w1',
  conversationId: 'c1',
  projectId: 'p1',
  adapter: 'rocketchat' as const,
  openedAt: new Date(),
  extendedAt: new Date(),
  firstSeq: 4,
  lastSeq: 5,
  claimedAt: new Date(),
  claimedBy: 'core-1',
  cutReason: null,
  deliveryReservedAt: null,
  closedAt: null,
  decision: null,
  decisionDetail: null,
};
const route = () =>
  routeWindow({
    window: WINDOW,
    manySpeakersPrincipalUserId: 'principal-1',
    inputs: () => ({ door: 'chat-sync', handleName: 'Babo' }),
  });
const turnRequest = () => runConversationTurn.mock.calls[0]?.[0] as Record<string, unknown>;
const statusTexts = () => deliver.mock.calls.map((c) => (c[1] as { text: string }).text);

beforeEach(() => {
  vi.clearAllMocks();
  acks.length = 0;
  conversationRow = { ...conversation, shape: 'group' };
  messageRows = [msg({})];
  sentByHandle = new Set();
  verdict = { speak: true };
  people = 2;
  transport = { deliver: (...a: unknown[]) => deliver(...a), acknowledge };
  runConversationTurn.mockResolvedValue({ kind: 'delivered', messageId: 'rc-9' });
});

describe('which windows are explicit requests (criterion 2)', () => {
  it('a group message naming the handle is one: working shown, received set, both cleared on answered (criteria 3, 6, 7, 8)', async () => {
    await expect(route()).resolves.toMatchObject({ decision: 'answered' });
    expect(acks).toEqual([
      { kind: 'working', on: true },
      { kind: 'received', messageId: 'rc-1', on: true },
      { kind: 'working', on: false },
      { kind: 'received', messageId: 'rc-1', on: false },
    ]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a group message replying to something the handle sent is one', async () => {
    messageRows = [msg({ content: 'still wrong', replyToExternalId: 'rc-bot-3' })];
    sentByHandle = new Set(['rc-bot-3']);
    await route();
    expect(acks[0]).toEqual({ kind: 'working', on: true });
  });

  it('a direct-room window is always one', async () => {
    conversationRow = { ...conversation, shape: 'direct' };
    messageRows = [msg({ content: 'why is CI red?', authorUserId: 'user-alice' })];
    await route();
    expect(acks).toContainEqual({ kind: 'received', messageId: 'rc-1', on: true });
  });

  it('a group window addressing nobody is not: no acknowledgement and no status whatever the outcome (criteria 5, 13)', async () => {
    messageRows = [msg({ content: 'the build is red again' })];
    runConversationTurn.mockResolvedValue({ kind: 'declined', reason: 'turn-failed' });
    await expect(route()).resolves.toMatchObject({ decision: 'nothing-to-say' });
    expect(acks).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a window the guards close gets no acknowledgement of any kind (criterion 5)', async () => {
    verdict = { speak: false, decision: 'guard-backoff', detail: {} };
    await expect(route()).resolves.toMatchObject({ decision: 'guard-backoff' });
    expect(acks).toEqual([]);
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it('the anchor is the LAST addressing message, not the newest message', async () => {
    messageRows = [
      msg({
        id: 'm1',
        seq: 4,
        externalId: 'rc-1',
        content: '@babo why is CI red?',
        createdAt: at(20),
      }),
      msg({
        id: 'm2',
        seq: 5,
        externalId: 'rc-2',
        content: 'never mind, bob',
        authorLabel: 'bob',
        authorKey: 'u-bob',
        createdAt: at(6),
      }),
    ];
    await route();
    expect(acks).toContainEqual({ kind: 'received', messageId: 'rc-1', on: true });
  });
});

describe('the one terminal status (criteria 9-17)', () => {
  it('a failed turn posts the nothing-posted status into the anchor’s thread, as the handle, once, and clears the receipt (criteria 9, 10, 15, 18)', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'declined', reason: 'turn-failed' });
    const routed = await route();
    expect(routed).toMatchObject({
      decision: 'nothing-to-say',
      detail: {
        reason: 'turn-failed',
        status: { status: 'nothing-posted', anchor: 'rc-1', delivered: true },
      },
    });
    expect(statusTexts()).toEqual([nothingPostedStatus('Babo')]);
    expect(deliver.mock.calls[0]?.[2]).toEqual({ anchor: 'rc-1' });
    expect(recordDeliveredReply).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: 'window:w1',
        decision: 'nothing-to-say',
        text: nothingPostedStatus('Babo'),
      }),
    );
    expect(reserveDelivery).toHaveBeenCalled();
    expect(acks.slice(-1)).toEqual([{ kind: 'received', messageId: 'rc-1', on: false }]);
  });

  it('a screen exhausted with nothing sent posts nothing-posted', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'declined', reason: 'screen-refused' });
    await route();
    expect(statusTexts()).toEqual([nothingPostedStatus('Babo')]);
  });

  it('an undeliverable turn is undetermined and posts the uncertainty wording, retrying nothing (criteria 11, 12; consult F5)', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'undeliverable', reason: 'POST timed out' });
    const routed = await route();
    expect(routed).toMatchObject({
      decision: 'undetermined',
      detail: { status: { status: 'uncertain' } },
    });
    expect(statusTexts()).toEqual([uncertainStatus('Babo')]);
    expect(runConversationTurn).toHaveBeenCalledTimes(1);
    expect(nothingPostedStatus('Babo')).not.toBe(uncertainStatus('Babo'));
  });

  it('deliberate silences post nothing (criterion 16)', async () => {
    for (const reason of ['nothing-to-say', 'tool-not-called']) {
      deliver.mockClear();
      runConversationTurn.mockResolvedValue({ kind: 'declined', reason });
      await route();
      expect(deliver).not.toHaveBeenCalled();
    }
  });

  it('a superseded turn posts nothing — the window is another holder’s', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'superseded', reason: 'moved on' });
    await route();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a diverted turn posts nothing — the answer arrives by another path', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'diverted', reason: 'agent lane' });
    await route();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a status the door refuses is logged and left, and the close says so (criterion 17)', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'declined', reason: 'turn-failed' });
    deliver.mockRejectedValueOnce(new Error('room rebound'));
    const routed = await route();
    expect(routed).toMatchObject({
      detail: { status: { status: 'nothing-posted', delivered: false, reason: 'room rebound' } },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(recordDeliveredReply).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalled();
  });

  it('a route that throws after the anchor is known closes unreachable and posts nothing-posted once (criteria 9, 15)', async () => {
    runConversationTurn.mockRejectedValue(new Error('boom'));
    await expect(route()).resolves.toMatchObject({ decision: 'unreachable' });
    expect(statusTexts()).toEqual([nothingPostedStatus('Babo')]);
    expect(acks.slice(-2)).toEqual([
      { kind: 'working', on: false },
      { kind: 'received', messageId: 'rc-1', on: false },
    ]);
    expect(closeWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'unreachable',
        detail: expect.objectContaining({ status: expect.objectContaining({ delivered: true }) }),
      }),
    );
  });

  it('a claim that moved on posts no status', async () => {
    runConversationTurn.mockResolvedValue({ kind: 'declined', reason: 'turn-failed' });
    reserveDelivery.mockResolvedValueOnce(false);
    const routed = await route();
    expect(deliver).not.toHaveBeenCalled();
    expect(routed).toMatchObject({ detail: { status: { delivered: false } } });
  });
});

describe('what the turn is told (criteria 19, 20)', () => {
  it('a group venue runs with fallbacks silenced and a direct one posts them (criterion 19)', async () => {
    await route();
    expect(turnRequest()).toMatchObject({ fallbacks: 'silence' });
    runConversationTurn.mockClear();
    conversationRow = { ...conversation, shape: 'direct' };
    messageRows = [msg({ content: 'hi', authorUserId: 'user-alice' })];
    await route();
    expect(turnRequest()).toMatchObject({ fallbacks: 'post', addressee: null });
  });

  it('addresses the ASKER when the room holds more than one person, even when somebody else spoke last (criterion 20; consult F7)', async () => {
    messageRows = [
      msg({
        id: 'm1',
        seq: 4,
        externalId: 'rc-1',
        content: '@babo why is CI red?',
        createdAt: at(20),
      }),
      msg({
        id: 'm2',
        seq: 5,
        externalId: 'rc-2',
        content: 'lunch?',
        authorLabel: 'bob',
        authorKey: 'u-bob',
        createdAt: at(6),
      }),
    ];
    await route();
    expect(turnRequest()).toMatchObject({ addressee: 'alice' });
  });

  it('addresses nobody in a room of one person, and nobody for unsolicited speech', async () => {
    people = 1;
    await route();
    expect(turnRequest()).toMatchObject({ addressee: null });
    runConversationTurn.mockClear();
    people = 3;
    messageRows = [msg({ content: 'the build is red again' })];
    await route();
    expect(turnRequest()).toMatchObject({ addressee: null });
  });
});

describe('a transport without acknowledge (criterion 1)', () => {
  it('routes as before: nothing acknowledged, the status still delivered', async () => {
    transport = { deliver: (...a: unknown[]) => deliver(...a) };
    runConversationTurn.mockResolvedValue({ kind: 'declined', reason: 'turn-failed' });
    await route();
    expect(acks).toEqual([]);
    expect(statusTexts()).toEqual([nothingPostedStatus('Babo')]);
  });
});
