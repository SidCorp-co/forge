/**
 * The order the routing steps hold in, and what that order protects.
 *
 * Each step is here because the next is only safe after it: a routeless room
 * costs no round trip, a room whose shape will not resolve is refused rather
 * than assumed, a registered thread never reaches the collector, and the
 * duplicate tracker is touched last. ISS-1004 removed the addressing step from
 * the middle of that list and made the room's arrival order the log's order,
 * which is the pair of properties this file measures. Split from
 * `connection-manager-shapes.test.ts` to keep both inside the size budget.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screenPasses } from '../../messaging/screen-passes.fixture.js';

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
/** Whether the room is still bound to the turn's project; flipped by the rebind case. */
const roomBound = true;
vi.mock('./room-delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./room-delivery.js')>()),
  roomStillBoundTo: async () => roomBound,
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

const fetchAttachmentBytes = vi.fn();
vi.mock('./rest-client.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchAttachmentBytes: (...args: unknown[]) => fetchAttachmentBytes(...args),
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

const loggerError = vi.fn();
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => loggerError(...args),
  },
}));

const resolveRoomShape = vi.fn();
vi.mock('./room-shape.js', () => ({
  resolveRoomShape: (...args: unknown[]) => resolveRoomShape(...args),
  roomShapeFromType: (t: string) => (t === 'd' ? 'direct' : 'group'),
}));

const openConversation = vi.fn(
  async (venue: { adapter: string; externalId: string; shape: string }) => ({
    id: `conv:${venue.externalId}`,
    adapter: venue.adapter,
    externalId: venue.externalId,
    shape: venue.shape,
    title: null,
  }),
);

const collected: Array<Record<string, unknown>> = [];
const conversationsById = new Map<
  string,
  { id: string; shape: 'direct' | 'group'; externalId: string }
>();

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
    const row = (await openConversation(...(args as [never]))) as {
      id: string;
      shape: 'direct' | 'group';
      externalId: string;
    };
    conversationsById.set(row.id, row);
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
const recordDeliveredReply = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock('../../conversations/transcript.js', () => ({
  recordDeliveredReply: (...a: unknown[]) => recordDeliveredReply(...(a as [never])),
}));
const deliver = vi.fn(async (..._a: unknown[]) => ({ messageId: 'rc-server-id-9' }));
const { clearConversationTransports, registerConversationTransport } = await import(
  '../../conversations/ports.js'
);

const { rocketChatManager } = await import('./connection-manager.js');

interface Loose {
  route(connectionId: string, m: unknown): Promise<void>;
  onMessage(connectionId: string, m: unknown): void;
  conns: Map<string, unknown>;
}
const loose = rocketChatManager as unknown as Loose;
const routeMessage = loose.route.bind(rocketChatManager);
const deliverToManager = loose.onMessage.bind(rocketChatManager);

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

beforeEach(() => {
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

describe('connection-manager routing order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenRoomReply.mockImplementation(screenPasses);
    resolveRoomShape.mockResolvedValue('group');
    loggerError.mockReset();
  });

  function connect(
    routes: Map<string, unknown>,
    seenMessage: (id: string) => boolean = () => false,
  ) {
    const ac = { ...makeAc(), routes, seenMessage: vi.fn(seenMessage) };
    loose.conns.set('conn-1', ac);
    return ac;
  }

  it('drops a message for a room it has no binding for without resolving a shape', async () => {
    const ac = connect(new Map());

    await routeMessage('conn-1', MESSAGE);

    expect(resolveRoomShape).not.toHaveBeenCalled();
    expect(ac.seenMessage).not.toHaveBeenCalled();
  });

  it('takes in a group message that names nobody', async () => {
    const ac = connect(new Map([['room-1', ROUTE]]));

    await routeMessage('conn-1', { ...MESSAGE, text: 'anyone know why CI is red?' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(ac.seenMessage).toHaveBeenCalledWith('msg-1');
    expect(openConversation).toHaveBeenCalledTimes(1);
  });

  it('reaches the tracker for a message it will handle', async () => {
    const ac = connect(new Map([['room-1', ROUTE]]));

    await routeMessage('conn-1', MESSAGE);

    expect(ac.seenMessage).toHaveBeenCalledWith('msg-1');
  });

  it('collects a re-emitted message id once, not twice', async () => {
    resolveRoomShape.mockResolvedValue('direct');
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'speaker-user-9' });
    const seen = new Set<string>();
    const ac = connect(new Map([['room-1', ROUTE]]), (id: string) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });

    const unaddressed = { ...MESSAGE, rid: 'room-1' };
    await routeMessage('conn-1', unaddressed);
    await routeMessage('conn-1', unaddressed);
    await new Promise((resolve) => setImmediate(resolve));

    expect(ac.seenMessage).toHaveBeenCalledTimes(2);
    expect(openConversation).toHaveBeenCalledTimes(1);
  });

  it('gives a failed collect its message id back, so the re-emit is taken in', async () => {
    const { createSeenTracker } = await import('./inbound-gate.js');
    const ac = {
      ...makeAc(),
      routes: new Map([['room-1', ROUTE]]),
      seenMessage: createSeenTracker(),
    };
    loose.conns.set('conn-1', ac);
    openConversation.mockRejectedValueOnce(new Error('the database went away'));

    await routeMessage('conn-1', MESSAGE);
    expect(openConversation).toHaveBeenCalledTimes(1);

    await routeMessage('conn-1', MESSAGE);
    expect(openConversation).toHaveBeenCalledTimes(2);
  });

  it('keeps two messages in a room in the order they arrived, whatever the lookups do', async () => {
    const ac = {
      ...makeAc(),
      routes: new Map([['room-1', ROUTE]]),
      seenMessage: () => false,
      routeTails: new Map(),
    };
    loose.conns.set('conn-1', ac);
    collected.length = 0;
    let slow = true;
    resolveRoomShape.mockImplementation(async () => {
      if (slow) {
        slow = false;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return 'group';
    });

    deliverToManager('conn-1', { ...MESSAGE, id: 'first', text: 'do not deploy' });
    deliverToManager('conn-1', { ...MESSAGE, id: 'second', text: 'deploy to staging' });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(collected.map((c) => c.content)).toEqual(['do not deploy', 'deploy to staging']);
  });

  it('refuses a message whose room shape does not resolve, and runs no turn', async () => {
    resolveRoomShape.mockResolvedValue(null);
    const ac = connect(new Map([['room-1', ROUTE]]));

    await routeMessage('conn-1', MESSAGE);

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(ac.seenMessage).not.toHaveBeenCalled();
    expect(ac.client.sendMessage).not.toHaveBeenCalled();
  });

  it('names the room it could not resolve', async () => {
    resolveRoomShape.mockResolvedValue(null);
    connect(new Map([['room-1', ROUTE]]));

    await routeMessage('conn-1', MESSAGE);

    const [ctx, message] = loggerError.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx.rid).toBe('room-1');
    expect(ctx.msgId).toBe('msg-1');
    expect(message).toContain('room type unresolved');
  });
});
