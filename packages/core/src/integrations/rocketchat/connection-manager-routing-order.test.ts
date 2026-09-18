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

// cm:guard a mock screen ADMITS the segments it was shown, rather than returning a bare `ok`:
// since ISS-978 a verdict carries what it was passed over, and a fake one that records nothing
// mints no proof — so a mock that merely says "it passed" silently turns every delivery in this
// file into a fallback.
import { admitted } from '../../messaging/screen.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
// cm:why stubbed: this file's fake db answers only the subject's own queries, and the room-is-still-ours check has its cases in room-delivery.test.ts.
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

// cm:why ISS-1004 split the old `handle()` in two: a message is COLLECTED into its conversation and its window, and the turn is taken later over everything the window holds. These fakes stand in for the rows that path reads, and `handle` below drives both halves so every assertion in this file still measures one message in and one reply out.
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
// cm:why `conversations/ports.js` is NOT stubbed: it is the registry the runner reads to find a venue's transport, so a stub would leave the adapter registering into one map and the turn reading another, and every delivery would refuse for a reason no room ever sees (ISS-1002).
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

// cm:why a turn's conversation is a ROW resolved per message, not a pointer on this instance: the Map it lived in emptied on every restart, so a room talking for weeks restarted empty (ISS-1001 criterion 1).
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

// cm:why the steps are ordered so a routeless room costs no round trip (ISS-987 criteria 10-12). ISS-1004 removed the addressing step between the shape and the tracker, so the tracker now sees every message in a bound room and its only job is the duplicate re-emit it was added for.
describe('connection-manager routing order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenRoomReply.mockImplementation(async (_door: unknown, input: { segments: readonly string[] }) =>
      admitted(input.segments),
    );
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

  // cm:guard the deliverable of ISS-1004 at this level: the message that used to be dropped for naming nobody is now the one that reaches the tracker and the collector. A change that put an addressing test back would make this the only assertion that went red.
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

  // cm:guard the mark is a claim the message is durable SOMEWHERE, so a collect that rolled back must withdraw it: RC re-emits the same id after enrichment, and a mark left by a failed attempt makes that re-emit a false duplicate — the question is then in no log and no window, and nobody is owed an answer for it (review pass 2 F3).
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

  // cm:guard the order the room typed in is the order the log holds, and the shape and thread lookups are what threaten it: two messages a moment apart can finish those round trips either way round, and the window would then show the model "deploy to staging" before "do not deploy" (review pass 2 F4).
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

  // cm:why the room has to be IN the refusal, not merely absent from the reply: an unresolvable room is a fault somebody has to find, and a log line that does not say which room leaves them the whole fleet to search
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
