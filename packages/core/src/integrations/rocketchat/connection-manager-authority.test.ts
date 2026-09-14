/**
 * ISS-987/ISS-1002 — whose authority a Rocket.Chat turn runs under, read through
 * the connection manager.
 *
 * The RULE is the neutral inbound half's and its cases are in
 * `conversations/inbound-turn.test.ts`; what this file holds is this adapter's
 * wiring to it — that the binding's principal is what a many-speaker room runs
 * as, that a refused speaker reaches the room through the one door, and the one
 * fault this adapter still answers on its own socket. Split from
 * `connection-manager-shapes.test.ts` to keep both inside the size budget.
 */

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
let lastOpened: { id: string; shape: 'direct' | 'group'; externalId: string } | null = null;

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
    lastOpened = row;
    return row;
  },
  getConversation: async (id: string) => conversationsById.get(id) ?? null,
  readMessages: async () => collected,
  readMessagesInRange: async () => collected,
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
  mentions: ['bot-1'],
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
// cm:why a DM has exactly one human and runs as them, while a channel has many speakers and no single authority and deliberately keeps the organization's creator (ISS-987 criteria 21-24, consuming ISS-977)
describe('connection-manager turn authority', () => {
  const answered = {
    conversationId: 'conv:chat.example.co room-1',
    reply: 'an answer',
    terminal: 'done',
    error: null,
    iterations: 1,
    toolCalls: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenRoomReply.mockResolvedValue({ ok: true });
    runExternalChatTurn.mockResolvedValue(answered);
  });

  const principalUsed = () =>
    (buildChatToolContext.mock.calls[0]?.[0] as { userId?: string } | undefined)?.userId;

  it('runs a direct room turn as the Forge user the speaker resolves to', async () => {
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'speaker-user-9' });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(principalUsed()).toBe('speaker-user-9');
  });

  // cm:guard authority and ATTRIBUTION are different questions and this asserts both on one message: the turn runs as the binding's principal, and the speaker is resolved all the same so the row says who actually spoke. ISS-1004 needs that second half — a second agent's message filed under the binding's human is invisible to the loop breaker — and it must never become the authority (ISS-987, ISS-1003).
  it('runs a group room turn as the organization creator, whoever spoke', async () => {
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'somebody-else' });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'group');

    expect(principalUsed()).toBe('user-1');
    expect(resolveSpeaker).toHaveBeenCalled();
  });

  it('runs no turn in a direct room whose speaker resolves to no Forge user', async () => {
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: { code: 'SPEAKER_UNLINKED', message: 'unlinked' },
    });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(buildChatToolContext).not.toHaveBeenCalled();
  });

  // cm:guard the room is shown the refusal the PORT wrote, with the step that links the speaker in it: this text is ISS-977's contract and a second copy here would drift from the endpoints it names the day they move. It goes out the ONE door rather than over this adapter's socket (ISS-1002).
  it('replies to an unlinked direct speaker with the port own refusal, verbatim', async () => {
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: { code: 'SPEAKER_UNLINKED', message: 'UNLINKED:user-1:link-yourself-here' },
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      text: 'UNLINKED:user-1:link-yourself-here',
    });
    expect(ac.client.sendMessage).not.toHaveBeenCalled();
  });

  // cm:guard a refusal the door would not take does NOT end the message: it is collected so the window can refuse it durably, and a person owed an answer is not left with neither one nor a record that they were (ISS-1004, review pass 1 F3).
  it('collects the message anyway when the refusal itself cannot be delivered', async () => {
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: { code: 'SPEAKER_UNLINKED', message: 'unlinked' },
    });
    deliver.mockRejectedValueOnce(new Error('the room would not take it'));
    collected.length = 0;

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(collected.map((c) => c.content)).toContain(MESSAGE.text);
  });

  it('collects nothing when the refusal did reach the person', async () => {
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: { code: 'SPEAKER_UNLINKED', message: 'unlinked' },
    });
    collected.length = 0;

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(collected).toHaveLength(0);
  });

  it('carries a non-unlinked refusal own message rather than rewording it', async () => {
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: { code: 'SPEAKER_SOURCE_UNKNOWN', message: 'that channel is not one Forge knows' },
    });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(deliver.mock.calls[0]?.[1]).toMatchObject({
      text: 'that channel is not one Forge knows',
    });
  });

  it('screens a direct room reply with the same output guard a group reply gets', async () => {
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'speaker-user-9' });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(screenRoomReply).toHaveBeenCalled();
  });

  // cm:guard the ONE case this adapter still posts itself, and the reason it must: a venue that could not be placed has no venue to deliver THROUGH, so this socket is the only way to the person. Confined to a one-to-one room, because a group room runs under the binding's principal and is owed no answer about an identity it never consults.
  it('tells a direct speaker the server address cannot be read as an identity', async () => {
    const ac = { ...makeAc(), serverUrl: 'https://broken.example.co' };
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: {
        code: 'SPEAKER_DIRECTORY_UNREACHABLE',
        message: "This Rocket.Chat server's address (https://broken.example.co) cannot be read",
      },
    });

    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    const [, text] = ac.client.sendMessage.mock.calls[0] as [string, string];
    expect(text).toContain('broken.example.co');
  });

  it('leaves a group room silent when its venue cannot be placed', async () => {
    const ac = { ...makeAc(), serverUrl: 'https://broken.example.co' };

    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(ac.client.sendMessage).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('stores the shape and the resolved speaker on an escalation it raises', async () => {
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'speaker-user-9' });
    runExternalChatTurn.mockResolvedValue({
      ...answered,
      reply: '',
      toolCalls: [{ name: 'escalate', arguments: '{"question":"why"}' }],
    });
    startEscalation.mockResolvedValue({ started: true, sessionId: 'esc-1' });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(startEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ shape: 'direct', principalUserId: 'speaker-user-9' }),
    );
  });
});
