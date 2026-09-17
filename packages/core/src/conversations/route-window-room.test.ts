/**
 * ISS-1087 — what a ROOM decides for itself: its own presence over the fold,
 * a reply to the handle as an address, and `tool` as a group mode. The mocks
 * are the shape `route-window-cut.test.ts` uses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversation = {
  id: 'c1',
  adapter: 'rocketchat' as const,
  externalId: 'chat.example.co room-1',
  shape: 'group' as 'group' | 'direct',
  title: null as string | null,
  presence: null as Record<string, unknown> | null,
};
let conversationRow: typeof conversation | null = conversation;
const message = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  seq: 4,
  role: 'user' as const,
  authorUserId: 'speaker-1' as string | null,
  authorLabel: 'alice',
  externalId: 'rc-1',
  replyToExternalId: null as string | null,
  content: 'is this still wrong?',
  images: [],
  deliveryProof: null,
  silenceReason: null,
  createdAt: new Date(),
  ...over,
});
let messageRows = [message()];
let sentByHandle = new Set<string>();

vi.mock('./store.js', () => ({
  getConversation: async () => conversationRow,
  readMessages: async () => messageRows,
  readMessagesInRange: async () => messageRows,
  deliveredDecisionUnderKey: async () => null,
  assistantSentExternalIds: async (_adapter: string, ids: string[]) =>
    new Set(ids.filter((id) => sentByHandle.has(id))),
  effectiveConversationMode: (row: { mode?: 'assistant' | 'agent' | null }) =>
    row.mode ?? 'assistant',
}));
const closeWindow = vi.fn(async () => null);
vi.mock('./windows.js', () => ({
  windowDeliveryKey: (id: string) => `window:${id}`,
  claimOf: (row: { claimedAt: Date | null; claimedBy: string | null }) =>
    row.claimedAt && row.claimedBy ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy } : null,
  closeWindow: (...a: unknown[]) => closeWindow(...(a as [])),
  reserveDelivery: async () => true,
  splitWindowTail: async () => true,
}));
vi.mock('./ports.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ports.js')>()),
  conversationTransport: () => ({ deliver: async () => ({ messageId: 'rc-9' }) }),
}));
vi.mock('./transcript.js', () => ({ recordDeliveredReply: async () => undefined }));
let verdict: unknown = { speak: true };
const decideProactivity = vi.fn(async (_input: unknown) => verdict);
vi.mock('./proactivity.js', async (orig) => ({
  ...(await orig<typeof import('./proactivity.js')>()),
  decideProactivity: (...a: unknown[]) => decideProactivity(a[0]),
}));
vi.mock('../config/env.js', () => ({ env: {} }));
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('./participants.js', () => ({
  roomHandles: async () => [{ userId: 'handle-1', handle: 'babo' }],
  handleForProject: async () => 'handle-1',
}));
let selves = new Map<string, { presence: Record<string, unknown> }>();
vi.mock('../orgs/agent-selves.js', () => ({ readSelvesFor: async () => selves }));
const runConversationTurn = vi.fn(async (_req?: unknown) => ({
  kind: 'delivered' as const,
  messageId: 'rc-9',
}));
vi.mock('./turn-runner.js', () => ({
  runConversationTurn: (...a: unknown[]) => runConversationTurn(a[0]),
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
  cutReason: 'quiet' as const,
  deliveryReservedAt: null,
  closedAt: null,
  decision: null,
  decisionDetail: null,
};
const route = () =>
  routeWindow({
    window: WINDOW,
    manySpeakersPrincipalUserId: 'principal-1',
    inputs: () => ({ door: 'chat-sync' as const, handleName: 'Babo' }),
  });
const turnRequest = () => runConversationTurn.mock.calls[0]?.[0] as Record<string, unknown>;
const thresholdsGiven = () => {
  const [input] = decideProactivity.mock.calls[0] ?? [];
  return (input as { thresholds: Record<string, unknown> }).thresholds;
};

beforeEach(() => {
  vi.clearAllMocks();
  conversationRow = { ...conversation, presence: null, shape: 'group' };
  messageRows = [message()];
  sentByHandle = new Set();
  selves = new Map();
  verdict = { speak: true };
});

describe('a room’s own presence over the fold', () => {
  it('closes not-mentioned under a room set to mention while every handle is in window mode (criterion 5)', async () => {
    conversationRow = { ...conversation, presence: { answerInGroup: 'mention' } };
    const out = await route();
    expect(out).toEqual({
      decision: 'nothing-to-say',
      detail: { reason: 'not-mentioned', handles: ['babo'] },
    });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it('hands the guards the room’s key and the fold’s for the rest (criterion 6)', async () => {
    selves = new Map([['handle-1', { presence: { loopLimit: 7 } }]]);
    conversationRow = { ...conversation, presence: { backoffAfter: 1 } };
    await route();
    expect(thresholdsGiven()).toMatchObject({ backoffAfter: 1, loopLimit: 7 });
  });
});

describe('a reply to the handle addresses it', () => {
  beforeEach(() => {
    selves = new Map([['handle-1', { presence: { answerInGroup: 'mention' } }]]);
  });

  it('routes a window whose message replies to something the handle sent (criterion 13)', async () => {
    messageRows = [message({ replyToExternalId: 'rc-bot-7' })];
    sentByHandle = new Set(['rc-bot-7']);
    const out = await route();
    expect(out).toMatchObject({ decision: 'answered' });
    expect(runConversationTurn).toHaveBeenCalledTimes(1);
  });

  it('closes not-mentioned when the reply target is a person’s message (criterion 14)', async () => {
    messageRows = [message({ replyToExternalId: 'rc-alice-2' })];
    sentByHandle = new Set(['rc-bot-7']);
    const out = await route();
    expect(out).toMatchObject({ decision: 'nothing-to-say', detail: { reason: 'not-mentioned' } });
  });
});

describe('tool as a group mode', () => {
  it('runs the guards first and hands the runner sendMode tool (criteria 17, 21)', async () => {
    conversationRow = { ...conversation, presence: { answerInGroup: 'tool' } };
    await route();
    expect(decideProactivity).toHaveBeenCalledTimes(1);
    expect(turnRequest()).toMatchObject({ sendMode: 'tool', mayDecline: true });
  });

  it('lets a guard stop the turn in tool mode as in window mode (criterion 17)', async () => {
    conversationRow = { ...conversation, presence: { answerInGroup: 'tool' } };
    verdict = { speak: false, decision: 'guard-backoff', detail: { windows: 3 } };
    const out = await route();
    expect(out).toMatchObject({ decision: 'guard-backoff' });
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  // cm:guard a direct room is one person asking one agent and is owed its reply, whatever the fold or the room says (criterion 21).
  it('reads as reply in a direct venue (criterion 21)', async () => {
    conversationRow = { ...conversation, shape: 'direct', presence: { answerInGroup: 'tool' } };
    await route();
    expect(turnRequest()).toMatchObject({ sendMode: 'reply' });
  });

  it('hands the runner sendMode reply in window mode', async () => {
    await route();
    expect(turnRequest()).toMatchObject({ sendMode: 'reply' });
  });
});
