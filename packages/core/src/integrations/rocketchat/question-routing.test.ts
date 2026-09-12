/**
 * ISS-978 — a reply in a question's thread is consumed by the question handler,
 * and anything else routes exactly as it did before.
 *
 * The harness is `connection-manager-shapes.test.ts`'s: this file exists beside
 * it rather than inside it because both are near the size budget.
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
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
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

const screenStakeholderReply = vi.fn();
vi.mock('./reply-screen.js', () => ({
  screenStakeholderReply: (...args: unknown[]) => screenStakeholderReply(...args),
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

describe('a reply inside a question thread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
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
    // cm:guard the fall-through carries the person's own words and their identity, which is what makes it a conversation turn rather than a routing event — a turn built from anything else answers somebody who did not speak.
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({
      message: MESSAGE.text,
      userKey: MESSAGE.userId,
      projectId: ROUTE.projectId,
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
    expect(runExternalChatTurn.mock.calls[0]?.[0]).toMatchObject({
      message: MESSAGE.text,
      source: 'rocketchat',
    });
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
