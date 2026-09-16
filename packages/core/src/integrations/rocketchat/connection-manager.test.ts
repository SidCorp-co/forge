/**
 * The ISS-675 escalation wiring and the ISS-727 answer-mode routing, through
 * `handle()`. The room-shape suites left for `connection-manager-shapes.test.ts`
 * and the image suite for `connection-manager-images.test.ts`, each time this
 * file reached the size budget. Heavy dependencies (registry/embeddings graph,
 * RC REST/DDP) are stubbed so this stays a fast, hermetic unit suite; `handle()`
 * is private, invoked via a loose cast (TS `private` is compile-time only).
 */
// cm:ignore CM013 — the one frozen comment left in this file is an `i18n-allow` pragma the language gate reads; deleting it to pay the drain reds that gate instead.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimedWindowFor } from './claimed-window.fixture.js';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    CORS_ORIGINS: 'https://forge.example.co',
    DATABASE_URL: 'postgres://test',
  },
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
// cm:why stubbed: this file's fake db answers only the subject's own queries, and the room-is-still-ours check has its cases in room-delivery.test.ts.
vi.mock('./room-delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./room-delivery.js')>()),
  roomStillBoundTo: async () => true,
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({ from: selectFrom })),
    transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  },
}));

const runExternalChatTurn = vi.fn();
vi.mock('../../assistant/external-chat.js', () => ({
  runExternalChatTurn: (...args: unknown[]) => runExternalChatTurn(...args),
}));

vi.mock('../../assistant/tools/registry.js', () => ({
  buildProjectToolset: () => ({ tools: [], execute: async () => ({ content: [] }) }),
}));

vi.mock('../../assistant/tools/external-mcp.js', () => ({
  buildExternalMcpToolsets: async () => ({ toolsets: [], dispose: async () => {} }),
}));

vi.mock('./context.js', () => ({
  buildConversationContext: async () => '',
  buildRocketChatHistoryToolset: () => ({ tools: [], execute: async () => ({ content: [] }) }),
}));

const startEscalation = vi.fn();
vi.mock('./escalation.js', () => ({
  ESCALATION_ACK: (botName: string) => `ACK:${botName}`,
  ESCALATION_DEDUP_REPLY: (botName: string) => `DEDUP:${botName}`,
  ESCALATION_NO_DEVICE_REPLY: (botName: string) => `NO_DEVICE:${botName}`,
  startEscalation: (...args: unknown[]) => startEscalation(...args),
}));

const screenRoomReply = vi.fn();
vi.mock('../../messaging/reply-screen.js', () => ({
  screenReplyAtDoor: (...args: unknown[]) => screenRoomReply(...args),
}));

const startAgentChat = vi.fn();
vi.mock('./agent-chat.js', () => ({
  AGENT_CHAT_ACK: (botName: string) => `AGENT_ACK:${botName}`,
  AGENT_CHAT_DEDUP_REPLY: (botName: string) => `AGENT_DEDUP:${botName}`,
  AGENT_CHAT_NO_DEVICE_REPLY: (botName: string) => `AGENT_NO_DEVICE:${botName}`,
  startAgentChat: (...args: unknown[]) => startAgentChat(...args),
}));

vi.mock('../store.js', () => ({
  decryptConnectionSecrets: vi.fn(),
  listBindingsForConnection: vi.fn(async () => []),
}));

const resolveSpeaker = vi.fn();
vi.mock('../../assistant/identity/speaker-link.js', () => ({
  resolveSpeaker: (...args: unknown[]) => resolveSpeaker(...args),
  unlinkedMessage: (ref: { externalId: string }) => `UNLINKED:${ref.externalId}:link-yourself-here`,
}));

vi.mock('../../assistant/identity/directory.js', () => ({
  namespaceFromServerUrl: (url: string) => (url.includes('broken') ? null : 'chat.example.co'),
}));

const buildChatToolContext = vi.fn((..._args: unknown[]) => ({
  principal: {},
  projectSlug: 'proj',
}));
vi.mock('../../assistant/tools/principal.js', () => ({
  buildChatToolContext: (...args: unknown[]) => buildChatToolContext(...args),
}));

// cm:why ISS-1004 split the old `handle()` in two: a message is COLLECTED into its conversation and its window, and the turn is taken later over everything the window holds. These fakes stand in for the rows that path reads, and `handle` below drives both halves so every assertion in this file still measures one message in and one reply out.
const collected: Array<Record<string, unknown>> = [];
const conversationsById = new Map<
  string,
  { id: string; shape: 'direct' | 'group'; externalId: string }
>();
let lastOpened: { id: string; shape: 'direct' | 'group'; externalId: string } | null = null;

// cm:guard the two ISS-1034 reads the window makes are answered at the module seam: `roomHandles`/`handleForProject` join tables this fake `select().from().where()` chain has no verb for, and `readSelvesFor` would otherwise consume a row the FIFO below queued for somebody else. Empty means "no self, no handle", which folds to today's constants — the regression these cases already guard (ISS-1034).
vi.mock('../../conversations/participants.js', async (orig) => ({
  ...(await orig<typeof import('../../conversations/participants.js')>()),
  roomHandles: async () => [],
  handleForProject: async () => null,
}));
vi.mock('../../orgs/agent-selves.js', () => ({ readSelvesFor: async () => new Map() }));
vi.mock('../../conversations/windows.js', () => ({
  windowDeliveryKey: (id: string) => `window:${id}`,
  openOrExtendWindow: async (a: { conversationId: string }) => ({
    id: `win:${a.conversationId}`,
    conversationId: a.conversationId,
  }),
  claimDueWindows: async () => [],
  claimOf: (row: { claimedAt: Date | null; claimedBy: string | null }) =>
    row.claimedAt && row.claimedBy ? { claimedAt: row.claimedAt, claimedBy: row.claimedBy } : null,
  closeWindow: async () => null,
  releaseWindow: async () => undefined,
  reserveDelivery: async () => true,
  recentDecisions: async () => [],
}));

vi.mock('../../conversations/proactivity.js', () => ({
  decideProactivity: async () => ({ speak: true }),
}));

vi.mock('../../conversations/store.js', () => ({
  openConversation: async (...args: unknown[]) => {
    const row = (await (async (venue: { adapter: string; externalId: string; shape: string }) => ({
      id: `conv:${venue.externalId}`,
      adapter: venue.adapter,
      externalId: venue.externalId,
      shape: venue.shape,
      title: null,
    }))(...(args as [never]))) as { id: string; shape: 'direct' | 'group'; externalId: string };
    conversationsById.set(row.id, row);
    lastOpened = row;
    return row;
  },
  getConversation: async (id: string) => conversationsById.get(id) ?? null,
  effectiveConversationMode: (row: { mode?: 'assistant' | 'agent' | null }) =>
    row.mode ?? 'assistant',
  readMessages: async () => collected,
  readMessagesInRange: async () => collected,
  deliveredDecisionUnderKey: async () => null,
  appendMessagesIn: async (_tx: unknown, args: { messages: Array<Record<string, unknown>> }) => {
    const rows = args.messages.map((msg, i) => ({
      id: `cm-${collected.length + i}`,
      seq: collected.length + i,
      role: msg.role,
      authorUserId: msg.authorUserId ?? null,
      authorLabel: msg.authorLabel ?? null,
      authorKey: msg.authorKey ?? null,
      externalId: msg.externalId ?? null,
      content: msg.content,
      images: msg.images ?? [],
      deliveryProof: null,
      silenceReason: null,
      createdAt: new Date(),
    }));
    collected.push(...rows);
    return rows;
  },
}));

// cm:why `conversations/ports.js` is NOT stubbed: it is the registry the runner reads to find a venue's transport, so a stub would leave the adapter registering into one map and the turn reading another, and every delivery would refuse for a reason no room ever sees (ISS-1002).
const deliver = vi.fn(async (..._a: unknown[]) => ({ messageId: 'rc-server-id-9' }));
const { clearConversationTransports, registerConversationTransport } = await import(
  '../../conversations/ports.js'
);

const recordDeliveredReply = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../conversations/transcript.js', () => ({
  recordDeliveredReply: (...a: unknown[]) => recordDeliveredReply(...(a as [never])),
}));

const resolveRoomShape = vi.fn();
vi.mock('./room-shape.js', () => ({
  resolveRoomShape: (...args: unknown[]) => resolveRoomShape(...args),
  roomShapeFromType: (t: string) => (t === 'd' ? 'direct' : 'group'),
}));

const { rocketChatManager } = await import('./connection-manager.js');
// cm:why the route half left the manager for `window-drain.ts` when the manager reached the size budget; the harness still drives collect-then-route as one call because that is the pair production runs.
const { routeOne } = await import('./window-drain.js');

interface Loose {
  collect(
    ac: unknown,
    route: unknown,
    m: unknown,
    connectionId: string,
    shape: 'direct' | 'group',
  ): Promise<void>;
}
const loose = rocketChatManager as unknown as Loose;
const collectOne = loose.collect.bind(rocketChatManager);

async function handle(
  ac: unknown,
  route: unknown,
  m: unknown,
  connectionId: string,
  shape: 'direct' | 'group',
): Promise<void> {
  collected.length = 0;
  lastOpened = null;
  const r = route as { rid: string; projectId: string };
  (ac as { routes: Map<string, unknown> }).routes.set(r.rid, route);
  await collectOne(ac, route, m, connectionId, shape);
  const opened = lastOpened as { id: string; shape: 'direct' | 'group'; externalId: string } | null;
  if (!opened) return;
  const window = claimedWindowFor(opened, r.projectId, Math.max(0, collected.length - 1));
  await routeOne(() => ac as never, connectionId, window as never, undefined);
}

function makeAc() {
  return {
    lockClient: {} as never,
    botUserId: 'bot-1',
    botName: 'Babo',
    serverUrl: 'https://chat.example.co',
    authToken: 'bot-token',
    routes: new Map(),
    reconnectAttempt: 0,
    seenMessage: () => false,
    routeTails: new Map(),
    closing: false,
    client: { sendMessage: vi.fn() },
  };
}

const ROUTE = {
  rid: 'room-1',
  projectId: 'proj-1',
  projectSlug: 'proj',
  projectName: 'Project',
  principalUserId: 'user-1',
};

const MESSAGE = {
  id: 'msg-1',
  rid: 'room-1',
  text: 'How does the pipeline work?',
  userId: 'user-1',
  username: 'alice',
  isSystem: false,
  isEdited: false,
  images: [],
};

// cm:guard the fake transport is the FOUR ports and the registry is the real one: `handle` is a caller of the neutral turn now, and a suite that stubbed the registry would prove the adapter against a delivery path production does not have (ISS-1002).
beforeEach(() => {
  // cm:why every message now resolves its speaker, whatever the room's shape — ISS-1004 attributes a collected message to whoever actually spoke, while authority still follows the shape. In a group room an unlinked speaker is a fact and not a refusal, so this default is the ordinary case.
  resolveSpeaker.mockResolvedValue({
    linked: false,
    refusal: { code: 'SPEAKER_UNLINKED', message: 'UNLINKED' },
  });
  clearConversationTransports();
  registerConversationTransport({
    adapter: 'rocketchat',
    deliver,
    fetchHistory: async () => [],
  });
  deliver.mockClear();
  deliver.mockResolvedValue({ messageId: 'rc-server-id-9' });
  recordDeliveredReply.mockClear();
});

describe('connection-manager escalation wiring', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: '/repo' }]);
    runExternalChatTurn.mockReset();
    startEscalation.mockReset();
    startAgentChat.mockReset();
    screenRoomReply.mockReset();
    screenRoomReply.mockResolvedValue({ ok: true });
  });

  it('posts the ACK and invokes startEscalation when the model calls escalate(); skips the normal reply', async () => {
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: true, sessionId: 'escalation-session-1' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(startEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        connectionId: 'conn-1',
        rid: 'room-1',
        botName: 'Babo',
        question: 'How does the pipeline work?',
      }),
    );
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'ACK:Babo' });
    // cm:why the escalate branch returns before the output-guard verify step, so this reply never reaches the screener
    expect(screenRoomReply).not.toHaveBeenCalled();
  });

  it('replies with the dedup message and does not double-dispatch on a second in-flight escalation', async () => {
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: false, reason: 'deduped' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'DEDUP:Babo' });
  });

  it('replies with the no-device message when no runner is available', async () => {
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: false, reason: 'no-device' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'NO_DEVICE:Babo' });
  });

  it('sends nothing over DDP on dispatch-failed — the completion bridge already delivers the fallback', async () => {
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: false, reason: 'dispatch-failed' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(deliver).not.toHaveBeenCalled();
  });

  it('takes the normal verify/reply path (not escalation) when the model answers without escalating', async () => {
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: 'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(startEscalation).not.toHaveBeenCalled();
    expect(screenRoomReply).toHaveBeenCalled();
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      text: 'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
    });
  });
});

describe('connection-manager ISS-727 answer-mode routing', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    runExternalChatTurn.mockReset();
    startAgentChat.mockReset();
    screenRoomReply.mockReset();
    screenRoomReply.mockResolvedValue({ ok: true });
  });

  it("mode='agent' routes to startAgentChat, skips the fast turn, and sends NO synchronous ack", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: true, sessionId: 'agent-session-1' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    // cm:guard the turn is addressed by VENUE, window and delivery key and no longer by a connection
    // id and a rid: the lane behind this call is shared with the Forge UI, and a room id reaching it
    // would be this transport's vocabulary back inside it (ISS-1039).
    expect(startAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        venue: expect.objectContaining({
          adapter: 'rocketchat',
          externalId: 'chat.example.co room-1',
          projectId: 'proj-1',
        }),
        conversationId: expect.any(String),
        windowId: expect.any(String),
        deliveryKey: expect.any(String),
        botName: 'Babo',
        message: 'How does the pipeline work?',
        askedByUsername: 'alice',
        persona: expect.any(String),
      }),
    );
    expect(startAgentChat.mock.calls[0]?.[0]).not.toHaveProperty('rid');
    expect(startAgentChat.mock.calls[0]?.[0]).not.toHaveProperty('connectionId');
    expect(runExternalChatTurn).not.toHaveBeenCalled();
    // cm:guard no immediate ack: a fast turn's answer arrives through the completion bridge, and only a slow turn gets the delayed ack, scheduled inside `startAgentChat` rather than sent from here.
    expect(deliver).not.toHaveBeenCalled();
  });

  it("mode='agent' replies with the dedup message on an in-flight agent-chat turn", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: false, reason: 'deduped' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'AGENT_DEDUP:Babo' });
  });

  it("mode='agent' replies with the no-device message when no runner is available", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: false, reason: 'no-device' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'AGENT_NO_DEVICE:Babo' });
  });

  it("mode='agent' sends nothing over DDP on dispatch-failed — the completion bridge delivers the fallback", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: false, reason: 'dispatch-failed' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(deliver).not.toHaveBeenCalled();
  });

  it('absent answerMode (null agentConfig) runs the existing fast path unchanged — regression guard', async () => {
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: '/repo' }]);
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: 'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(startAgentChat).not.toHaveBeenCalled();
    expect(runExternalChatTurn).toHaveBeenCalled();
  });

  it("mode='fast' (explicit) runs the existing fast path unchanged — regression guard", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'fast' }, repoPath: '/repo' },
    ]);
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: 'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(startAgentChat).not.toHaveBeenCalled();
    expect(runExternalChatTurn).toHaveBeenCalled();
  });
});
