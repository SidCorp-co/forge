/**
 * The image path through `handle()`: the bytes the model is shown, the
 * credential they are fetched with, and what happens when the fetch fails.
 * Split from `connection-manager.test.ts` to keep both files inside the size
 * budget, following the room-shape split before it.
 *
 * Heavy dependencies (registry/embeddings graph, RC REST/DDP) are stubbed so
 * this stays a fast, hermetic unit suite; `handle()` is private, invoked via a
 * loose cast (TS `private` is compile-time only).
 */

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

// cm:why ISS-1004 split the old `handle()` in two: a message is COLLECTED into its conversation and its window, and the turn is taken later over everything the window holds. These fakes stand in for the rows that path reads, and `handle` below drives both halves so every assertion in this file still measures one message in and one reply out.
const collected: Array<Record<string, unknown>> = [];
const conversationsById = new Map<
  string,
  { id: string; shape: 'direct' | 'group'; externalId: string }
>();
let lastOpened: { id: string; shape: 'direct' | 'group'; externalId: string } | null = null;

vi.mock('../../conversations/windows.js', () => ({
  windowDeliveryKey: (id: string) => `window:${id}`,
  openOrExtendWindow: async (a: { conversationId: string }) => ({
    id: `win:${a.conversationId}`,
    conversationId: a.conversationId,
  }),
  claimDueWindows: async () => [],
  closeWindow: async () => null,
  releaseWindow: async () => undefined,
  reserveDelivery: async () => undefined,
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
  readMessages: async () => collected,
  deliveredUnderKey: async () => false,
  appendMessagesIn: async (_tx: unknown, args: { messages: Array<Record<string, unknown>> }) => {
    const rows = args.messages.map((msg, i) => ({
      id: `cm-${collected.length + i}`,
      seq: collected.length + i,
      role: msg.role,
      authorUserId: msg.authorUserId ?? null,
      authorLabel: msg.authorLabel ?? null,
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
  await routeOne(
    ac as never,
    connectionId,
    {
      id: `win:${opened.id}`,
      conversationId: opened.id,
      projectId: r.projectId,
      adapter: 'rocketchat',
      venueExternalId: opened.externalId,
      venueShape: opened.shape,
      openedAt: new Date(),
      extendedAt: new Date(),
      firstSeq: 0,
      lastSeq: Math.max(0, collected.length - 1),
      claimedAt: new Date(),
      claimedBy: 'test',
      deliveryReservedAt: null,
      closedAt: null,
      decision: null,
      decisionDetail: null,
    },
    undefined,
  );
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

describe('connection-manager image handling', () => {
  const IMAGE = {
    name: 'shot.png',
    mime: 'image/png',
    ref: 'https://chat.example.co/file-upload/a/shot.png',
  };

  interface TurnArgs {
    images: Array<{ name: string; mime: string; ref: string; dataBase64: string }>;
    resolveImage: (i: { ref: string }) => Promise<string | null>;
  }
  const turnArgs = () => runExternalChatTurn.mock.calls[0]?.[0] as TurnArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenRoomReply.mockResolvedValue({ ok: true });
    runExternalChatTurn.mockResolvedValue({
      conversationId: 'conv:chat.example.co room-1',
      reply: 'that toggle reads the wrong tier',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
      progress: null,
    });
  });

  it('shows the model the bytes of the image posted in the room', async () => {
    fetchAttachmentBytes.mockResolvedValue(Buffer.from('PNG'));
    await handle(makeAc(), ROUTE, { ...MESSAGE, images: [IMAGE] }, 'conn-1', 'group');

    expect(turnArgs().images).toEqual([{ ...IMAGE, dataBase64: 'UE5H' }]);
    expect(Buffer.from(turnArgs().images[0]?.dataBase64 ?? '', 'base64').toString()).toBe('PNG');
  });

  it('fetches the image with the bot credential, not anonymously', async () => {
    fetchAttachmentBytes.mockResolvedValue(Buffer.from('PNG'));
    await handle(makeAc(), ROUTE, { ...MESSAGE, images: [IMAGE] }, 'conn-1', 'group');

    const [auth, ref, cap] = fetchAttachmentBytes.mock.calls[0] as [
      { authToken: string; userId: string; serverUrl: string },
      string,
      number,
    ];
    expect(auth.authToken).toBe('bot-token');
    expect(auth.serverUrl).toBe('https://chat.example.co');
    expect(ref).toBe(IMAGE.ref);
    expect(cap).toBeGreaterThan(0);
  });

  it('still answers the question when the image cannot be fetched', async () => {
    fetchAttachmentBytes.mockResolvedValue(null);
    const ac = makeAc();
    await handle(ac, ROUTE, { ...MESSAGE, images: [IMAGE] }, 'conn-1', 'group');

    expect(turnArgs().images).toEqual([]);
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({ externalId: 'chat.example.co room-1' });
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ text: 'that toggle reads the wrong tier' });
  });

  it('offers a resolver that re-reads an image from an earlier turn', async () => {
    fetchAttachmentBytes.mockResolvedValue(Buffer.from('OLD'));
    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'group');

    expect(await turnArgs().resolveImage(IMAGE)).toBe('T0xE');
  });

  it('downloads nothing for a plain message with no images', async () => {
    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'group');

    expect(fetchAttachmentBytes.mock.calls).toEqual([]);
    expect(turnArgs().images).toEqual([]);
  });
});
