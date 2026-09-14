/**
 * ISS-1001 — what the transcript keeps of a delivered reply.
 *
 * A third sibling of `connection-manager.test.ts` for the reason the second one
 * exists: both are at the size budget. The subject here is the one thing a
 * person reading a room's transcript cannot check for themselves — that the
 * sentence in the row is the sentence the room was shown, with the receipt the
 * server returned for it.
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
let roomBound = true;
// cm:why stubbed: this file's fake db answers only the subject's own queries, and the room-is-still-ours check has its cases in room-delivery.test.ts.
vi.mock('./room-delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./room-delivery.js')>()),
  roomStillBoundTo: async () => roomBound,
}));

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

const screenRoomReply = vi.fn();
vi.mock('./reply-screen.js', () => ({
  screenRoomReply: (...args: unknown[]) => screenRoomReply(...args),
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

const openConversation = vi.fn(async (venue: { adapter: string; externalId: string }) => ({
  id: `conv:${venue.externalId}`,
  adapter: venue.adapter,
  externalId: venue.externalId,
  shape: 'direct',
  title: null,
}));
const recordDelivery = vi.fn(async (..._a: unknown[]) => undefined);
const appendMessage = vi.fn(async (..._a: unknown[]) => ({ id: 'row-new' }));
vi.mock('../../conversations/store.js', () => ({
  openConversation: (...args: unknown[]) => openConversation(...(args as [never])),
  recordDelivery: (...args: unknown[]) => recordDelivery(...(args as [never])),
  appendMessage: (...args: unknown[]) => appendMessage(...(args as [never])),
}));
vi.mock('../../conversations/participants.js', () => ({
  handleForProject: async () => 'handle-user-1',
}));
vi.mock('../../conversations/ports.js', () => ({
  registerConversationTransport: vi.fn(),
}));

const { rocketChatManager } = await import('./connection-manager.js');

interface Loose {
  handle(
    ac: unknown,
    route: unknown,
    m: unknown,
    connectionId: string,
    shape: 'direct' | 'group',
  ): Promise<void>;
  conns: Map<string, unknown>;
}
const loose = rocketChatManager as unknown as Loose;
const handle = loose.handle.bind(rocketChatManager);

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

const REFUSAL = {
  rule: 'no-developer-detail',
  why: 'leaks a code fence',
  quote: null,
  shape: 'plain language',
  example: 'The fix is in.',
} as const;

describe('what the transcript keeps of a delivered reply', () => {
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
    resolveRoomShape.mockResolvedValue('group');
  });

  // cm:guard the receipt is stamped on the row the turn wrote, from what the SEND returned: the row
  // already proves the answer was composed, and only the server's id proves the room received it.
  it('stamps the delivered message with the receipt its adapter returned', async () => {
    const ac = makeAc();
    ac.client.sendMessage.mockResolvedValue('rc-server-id-9');
    runExternalChatTurn.mockResolvedValue({ ...answered, assistantMessageId: 'row-7' });

    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(recordDelivery).toHaveBeenCalledWith('row-7', { messageId: 'rc-server-id-9' });
  });

  // cm:guard a reply the room SAW and the transcript does not hold is the one difference the transcript exists to record: a fixed fallback carries no row of its own, so the transcript kept the text the screen rejected and nothing the person read.
  it('writes the reply the room saw as its own row when the turn wrote none', async () => {
    const ac = makeAc();
    ac.client.sendMessage.mockResolvedValue('rc-server-id-9');
    screenRoomReply.mockResolvedValue({
      ok: false,
      refusals: [{ ...REFUSAL, why: 'unverified' }],
    });
    runExternalChatTurn.mockResolvedValue({ ...answered, assistantMessageId: null });

    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(recordDelivery).not.toHaveBeenCalled();
    const sent = ac.client.sendMessage.mock.calls.at(-1)?.[1];
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv:chat.example.co room-1',
        role: 'assistant',
        content: sent,
        authorUserId: 'handle-user-1',
        deliveryProof: { messageId: 'rc-server-id-9' },
      }),
    );
  });

  // cm:guard the rejected answer and the corrective instruction never reach the room's transcript: the room saw the RETRY, and a transcript holding what the guard refused is a record of a conversation nobody had.
  it('records the question, and the answer only once the room has been shown one', async () => {
    const ac = makeAc();
    ac.client.sendMessage.mockResolvedValue('rc-server-id-9');
    screenRoomReply
      .mockResolvedValueOnce({
        ok: false,
        refusals: [{ ...REFUSAL, why: 'unverified' }],
      })
      .mockResolvedValueOnce({ ok: true });
    runExternalChatTurn
      .mockResolvedValueOnce({ ...answered, reply: 'rejected text', assistantMessageId: null })
      .mockResolvedValueOnce({ ...answered, reply: 'the retry answer', assistantMessageId: null });

    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    const first = runExternalChatTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    const retry = runExternalChatTurn.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(first.record).toBe('question-only');
    expect(retry.record).toBe('nothing');
    expect(ac.client.sendMessage.mock.calls.at(-1)?.[1]).toBe('the retry answer');
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', content: 'the retry answer' }),
    );
  });

  // cm:guard a turn runs for up to HANDLE_TIMEOUT_MS and the binding can move while it does: the
  // answer computed for this project must not be posted into a room another project now owns.
  it('posts nothing when the room was rebound while the turn ran', async () => {
    const ac = makeAc();
    ac.client.sendMessage.mockResolvedValue('rc-server-id-9');
    runExternalChatTurn.mockResolvedValue({ ...answered, assistantMessageId: 'row-7' });
    roomBound = false;
    try {
      await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');
    } finally {
      roomBound = true;
    }
    expect(ac.client.sendMessage).not.toHaveBeenCalled();
    expect(recordDelivery).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('appends nothing extra when the turn already wrote the row that was sent', async () => {
    const ac = makeAc();
    ac.client.sendMessage.mockResolvedValue('rc-server-id-9');
    runExternalChatTurn.mockResolvedValue({ ...answered, assistantMessageId: 'row-7' });

    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'group');

    expect(appendMessage).not.toHaveBeenCalled();
  });
});
