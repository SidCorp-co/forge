/**
 * ISS-978 — a reply in a question's thread is consumed by the question handler,
 * and anything else routes exactly as it did before.
 *
 * The harness is `connection-manager-shapes.test.ts`'s: this file exists beside
 * it rather than inside it because both are near the size budget.
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

// cm:why ISS-1004 stopped `route()` answering a message and made it COLLECT one: what this file measures is which handler a message reaches, so the assertions that used to read a turn's arguments now read the row the collector wrote. `conversationsById` is what a later route would read it back through, and is here because the store mock owes it whether this file uses it or not.
const collected: Array<Record<string, unknown>> = [];
const conversationsById = new Map<string, { id: string; shape: string; externalId: string }>();

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
    }))(...(args as [never]))) as { id: string; shape: string; externalId: string };
    conversationsById.set(row.id, row);
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

// cm:why `conversations/ports.js` is NOT stubbed: it is the registry the neutral turn reads to find a venue's transport, so a stub makes every fall-through turn refuse before it runs and the assertion below would pass for the wrong reason (ISS-1002).
const deliver = vi.fn(async (..._a: unknown[]) => ({ messageId: 'rc-server-id-9' }));
const { clearConversationTransports, registerConversationTransport } = await import(
  '../../conversations/ports.js'
);

vi.mock('../../conversations/transcript.js', () => ({
  recordDeliveredReply: async () => undefined,
}));

vi.mock('./room-shape.js', () => ({
  resolveRoomShape: (...args: unknown[]) => resolveRoomShape(...args),
  roomShapeFromType: (t: string) => (t === 'd' ? 'direct' : 'group'),
}));

const { rocketChatManager } = await import('./connection-manager.js');

interface Loose {
  route(connectionId: string, m: unknown): Promise<void>;
  conns: Map<string, unknown>;
}
const loose = rocketChatManager as unknown as Loose;
const routeMessage = loose.route.bind(rocketChatManager);

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
  mentions: ['bot-1'],
  images: [],
};

const subjectForThread = vi.fn();
const consumeQuestionThreadReply = vi.fn();
const consumeIssueThreadReply = vi.fn();
vi.mock('./question-delivery.js', () => ({
  startQuestionDrainLoop: vi.fn(() => () => {}),
}));
vi.mock('./comment-mirror.js', () => ({
  startCommentMirrorLoop: vi.fn(() => () => {}),
}));
vi.mock('./thread-registry.js', () => ({
  subjectForThread: (...args: unknown[]) => subjectForThread(...args),
}));
vi.mock('./question-inbound.js', () => ({
  consumeQuestionThreadReply: (...args: unknown[]) => consumeQuestionThreadReply(...args),
}));
vi.mock('./comment-inbound.js', () => ({
  consumeIssueThreadReply: (...args: unknown[]) => consumeIssueThreadReply(...args),
}));

// cm:guard `route` fires the conversation handler unawaited (`void this.handle(...)`), so a fall-through is only observable after the microtask queue drains — asserting straight after `route` returns reads every fall-through as a consumption.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  // cm:why every message now resolves its speaker, whatever the room's shape — ISS-1004 attributes a collected message to whoever actually spoke, while authority still follows the shape. In a group room an unlinked speaker is a fact and not a refusal, so this default is the ordinary case.
  resolveSpeaker.mockResolvedValue({
    linked: false,
    refusal: { code: 'SPEAKER_UNLINKED', message: 'UNLINKED' },
  });
  clearConversationTransports();
  registerConversationTransport({ adapter: 'rocketchat', deliver, fetchHistory: async () => [] });
});

describe('a reply inside a question thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenRoomReply.mockImplementation(async (_door: unknown, input: { segments: readonly string[] }) =>
      admitted(input.segments),
    );
    resolveRoomShape.mockResolvedValue('group');
    subjectForThread.mockResolvedValue(null);
    consumeQuestionThreadReply.mockReturnValue(undefined);
  });

  function connected(connectionId = 'conn-1') {
    const ac = makeAc();
    ac.routes.set('room-1', ROUTE);
    loose.conns.set(connectionId, ac);
    return ac;
  }

  it('hands an owned thread to the question handler and runs no turn', async () => {
    connected();
    subjectForThread.mockResolvedValue({ kind: 'question', questionId: 'q-1' });
    await routeMessage('conn-1', { ...MESSAGE, tmid: 'thread-1', mentions: [] });
    // cm:guard the flush is what makes the fall-through representable: `route` fires the conversation handler unawaited, so asserting `runExternalChatTurn` straight after `route` returns passes whether or not the owned-thread branch returns.
    await flush();
    expect(consumeQuestionThreadReply.mock.calls[0]?.[0]).toMatchObject({
      questionId: 'q-1',
      connectionId: 'conn-1',
    });
    expect(consumeQuestionThreadReply.mock.calls[0]?.[0]?.m?.tmid).toBe('thread-1');
    // cm:guard the conversation handler is what must NOT have run: a refusal that fell through to it would reach the person as a chat reply about something else, and would additionally spend a provider turn (ISS-978 criterion 20).
    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(startEscalation).not.toHaveBeenCalled();
    expect(startAgentChat).not.toHaveBeenCalled();
  });

  it('hands an issue thread to the comment handler, and never to the question one', async () => {
    connected();
    subjectForThread.mockResolvedValue({ kind: 'issue', issueId: 'iss-1', retired: false });
    await routeMessage('conn-1', { ...MESSAGE, tmid: 'thread-2', mentions: [] });
    await flush();
    expect(consumeIssueThreadReply.mock.calls[0]?.[0]).toMatchObject({
      issueId: 'iss-1',
      retired: false,
      connectionId: 'conn-1',
    });
    // cm:guard the question handler is what must NOT have run: prose routed there would be read as choosing an option, which grants a permission nobody selected (ISS-981 criteria 18, 29).
    expect(consumeQuestionThreadReply).not.toHaveBeenCalled();
    expect(runExternalChatTurn).not.toHaveBeenCalled();
  });

  // cm:guard each of these three is dropped by `decideSkip` BEFORE the thread is resolved, so the assertion is that an owned issue thread does not buy the message a second chance: a skip moved below the thread lookup would make a reaction on a root into a comment saying nothing (ISS-981 criteria 14, 15, 16).
  it.each([
    [
      'a reaction, which Rocket.Chat re-emits as an edit of the message it is on',
      { isEdited: true },
    ],
    ['an edit of a message already said', { isEdited: true }],
    ['a system event carrying no words', { isSystem: true }],
    ['text that is empty', { text: '' }],
    ['text that is only whitespace', { text: '   \n  ' }],
  ])('writes no comment for %s', async (_name, overrides) => {
    connected();
    subjectForThread.mockResolvedValue({ kind: 'issue', issueId: 'iss-1', retired: false });
    await routeMessage('conn-1', { ...MESSAGE, tmid: 'thread-2', mentions: [], ...overrides });
    await flush();
    expect(consumeIssueThreadReply).not.toHaveBeenCalled();
    expect(runExternalChatTurn).not.toHaveBeenCalled();
  });

  it('consumes a retired issue thread rather than letting it reach a model', async () => {
    connected();
    subjectForThread.mockResolvedValue({ kind: 'issue', issueId: 'iss-1', retired: true });
    await routeMessage('conn-1', { ...MESSAGE, tmid: 'thread-2', mentions: [] });
    await flush();
    expect(consumeIssueThreadReply.mock.calls[0]?.[0]).toMatchObject({ retired: true });
    expect(runExternalChatTurn).not.toHaveBeenCalled();
  });

  it('needs no @-mention inside an owned thread', async () => {
    connected();
    subjectForThread.mockResolvedValue({ kind: 'question', questionId: 'q-1' });
    await routeMessage('conn-1', { ...MESSAGE, tmid: 'thread-1', mentions: [] });
    await flush();
    expect(consumeQuestionThreadReply.mock.calls[0]?.[0]).toMatchObject({
      questionId: 'q-1',
      connectionId: 'conn-1',
    });
  });

  it('leaves a thread it does not own to the conversation handler', async () => {
    connected();
    subjectForThread.mockResolvedValue(null);
    runExternalChatTurn.mockResolvedValue({
      sessionId: 's',
      reply: 'an answer',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });
    await routeMessage('conn-1', { ...MESSAGE, tmid: 'someone-elses-thread' });
    await flush();
    expect(consumeQuestionThreadReply).not.toHaveBeenCalled();
    // cm:guard the fall-through carries the person's own words and their identity, which is what makes it a conversation turn rather than a routing event — a turn built from anything else answers somebody who did not speak. Since ISS-1004 the fall-through is a COLLECT rather than a turn, so the words are asserted where they now land: the row the window will route.
    expect(collected[0]).toMatchObject({
      content: MESSAGE.text,
      authorLabel: MESSAGE.username,
      externalId: MESSAGE.id,
    });
  });

  it('asks nothing about a message carrying no thread at all', async () => {
    connected();
    runExternalChatTurn.mockResolvedValue({
      sessionId: 's',
      reply: 'an answer',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });
    await routeMessage('conn-1', MESSAGE);
    await flush();
    expect(subjectForThread).not.toHaveBeenCalled();
    expect(collected[0]).toMatchObject({ content: MESSAGE.text, role: 'user' });
  });

  it('asks nothing when the connection has no route for the room', async () => {
    const ac = makeAc();
    loose.conns.set('conn-routeless', ac);
    await routeMessage('conn-routeless', { ...MESSAGE, tmid: 'thread-1' });
    await flush();
    // cm:guard the thread lookup sits AFTER the route for the reason the shape does: the same bot is subscribed on every connection's socket, so a routeless connection must touch nothing (ISS-978 criterion 22).
    expect(subjectForThread).not.toHaveBeenCalled();
    expect(consumeQuestionThreadReply).not.toHaveBeenCalled();
  });

  it('drops the bot own message in an owned thread rather than answering it', async () => {
    connected();
    subjectForThread.mockResolvedValue({ kind: 'question', questionId: 'q-1' });
    await routeMessage('conn-1', { ...MESSAGE, tmid: 'thread-1', userId: 'bot-1' });
    await flush();
    expect(consumeQuestionThreadReply).not.toHaveBeenCalled();
    expect(runExternalChatTurn).not.toHaveBeenCalled();
  });

  it('hands the connection over whole, so the socket is the question handler to judge', async () => {
    const ac = connected('conn-dead');
    ac.routes.set('room-1', ROUTE);
    (ac as { client?: unknown }).client = undefined;
    subjectForThread.mockResolvedValue({ kind: 'question', questionId: 'q-1' });
    await routeMessage('conn-dead', { ...MESSAGE, tmid: 'thread-1', mentions: [] });
    await flush();
    // cm:guard the message is consumed even with no socket to answer on: falling through to the conversation handler instead would run a provider turn for a reply that is an answer to a question (ISS-978 criterion 20).
    expect(consumeQuestionThreadReply.mock.calls[0]?.[0]).toMatchObject({
      questionId: 'q-1',
      connectionId: 'conn-dead',
    });
    expect(consumeQuestionThreadReply.mock.calls[0]?.[0]?.ac?.client).toBeUndefined();
    expect(runExternalChatTurn).not.toHaveBeenCalled();
  });
});
