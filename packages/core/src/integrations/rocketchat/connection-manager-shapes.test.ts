/**
 * ISS-987 — the three room shapes, read through the connection manager: which
 * conversation a turn belongs to, whose authority it runs under, and the order
 * the four routing steps hold in. Split from `connection-manager.test.ts` to
 * keep both files inside the size budget.
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

const resolveRoomShape = vi.fn();
vi.mock('./room-shape.js', () => ({
  resolveRoomShape: (...args: unknown[]) => resolveRoomShape(...args),
  roomShapeFromType: (t: string) => (t === 'd' ? 'direct' : 'group'),
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
  route(connectionId: string, m: unknown): Promise<void>;
  conns: Map<string, unknown>;
}
const loose = rocketChatManager as unknown as Loose;
const handle = loose.handle.bind(rocketChatManager);
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

// cm:why the conversation, not the room, is what a chat session belongs to: two live threads keyed on one rid shared a `chat_sessions` row and read each other's turns back as their own history, which is exactly the failure a thread was opened to avoid (ISS-987 criteria 13-17)
describe('connection-manager conversation identity', () => {
  const answered = {
    sessionId: 'chat-session-1',
    reply: 'an answer',
    terminal: 'done',
    error: null,
    iterations: 1,
    toolCalls: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
  });

  const sessionIdSentOn = (call: number) =>
    (runExternalChatTurn.mock.calls[call]?.[0] as { sessionId?: string } | undefined)?.sessionId;

  it('gives two threads in one room two different chat sessions', async () => {
    const ac = makeAc();
    const room = { ...ROUTE, rid: 'room-two-threads' };
    const m = { ...MESSAGE, rid: 'room-two-threads' };
    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-thread-a' });
    await handle(ac, room, { ...m, tmid: 'thread-a' }, 'conn-1', 'group');

    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-thread-b' });
    await handle(ac, room, { ...m, id: 'msg-2', tmid: 'thread-b' }, 'conn-1', 'group');

    expect(sessionIdSentOn(0)).toBeUndefined();
    expect(sessionIdSentOn(1)).toBeUndefined();
  });

  it('does not hand a thread the session the room main channel is holding', async () => {
    const ac = makeAc();
    const room = { ...ROUTE, rid: 'room-holding' };
    const m = { ...MESSAGE, rid: 'room-holding' };
    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-room' });
    await handle(ac, room, m, 'conn-1', 'group');

    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-thread' });
    await handle(ac, room, { ...m, id: 'msg-2', tmid: 'thread-fresh' }, 'conn-1', 'group');

    expect(sessionIdSentOn(1)).toBeUndefined();
  });

  it('continues the session a second message in the same thread belongs to', async () => {
    const ac = makeAc();
    const room = { ...ROUTE, rid: 'room-continue-thread' };
    const m = { ...MESSAGE, rid: 'room-continue-thread' };
    runExternalChatTurn.mockResolvedValue({ ...answered, sessionId: 'session-thread-a' });

    await handle(ac, room, { ...m, tmid: 'thread-a' }, 'conn-1', 'group');
    await handle(ac, room, { ...m, id: 'msg-2', tmid: 'thread-a' }, 'conn-1', 'group');

    expect(sessionIdSentOn(1)).toBe('session-thread-a');
  });

  it('continues the room own session for a second unthreaded message', async () => {
    const ac = makeAc();
    const room = { ...ROUTE, rid: 'room-continue-main' };
    const m = { ...MESSAGE, rid: 'room-continue-main' };
    runExternalChatTurn.mockResolvedValue({ ...answered, sessionId: 'session-room' });

    await handle(ac, room, m, 'conn-1', 'group');
    await handle(ac, room, { ...m, id: 'msg-2' }, 'conn-1', 'group');

    expect(sessionIdSentOn(1)).toBe('session-room');
  });

  it('clears only the failing conversation session and leaves the room own in place', async () => {
    const ac = makeAc();
    const room = { ...ROUTE, rid: 'room-failing' };
    const m = { ...MESSAGE, rid: 'room-failing' };
    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-room' });
    await handle(ac, room, m, 'conn-1', 'group');

    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-thread' });
    await handle(ac, room, { ...m, id: 'msg-2', tmid: 'thread-a' }, 'conn-1', 'group');

    runExternalChatTurn.mockRejectedValueOnce(new Error('provider exploded'));
    await handle(ac, room, { ...m, id: 'msg-3', tmid: 'thread-a' }, 'conn-1', 'group');

    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-room' });
    await handle(ac, room, { ...m, id: 'msg-4' }, 'conn-1', 'group');
    expect(sessionIdSentOn(3)).toBe('session-room');

    runExternalChatTurn.mockResolvedValueOnce({ ...answered, sessionId: 'session-thread-2' });
    await handle(ac, room, { ...m, id: 'msg-5', tmid: 'thread-a' }, 'conn-1', 'group');
    expect(sessionIdSentOn(4)).toBeUndefined();
  });
});

// cm:why a DM has exactly one human and runs as them, while a channel has many speakers and no single authority and deliberately keeps the organization's creator (ISS-987 criteria 21-24, consuming ISS-977)
describe('connection-manager turn authority', () => {
  const answered = {
    sessionId: 'chat-session-1',
    reply: 'an answer',
    terminal: 'done',
    error: null,
    iterations: 1,
    toolCalls: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
    runExternalChatTurn.mockResolvedValue(answered);
  });

  const principalUsed = () =>
    (buildChatToolContext.mock.calls[0]?.[0] as { userId?: string } | undefined)?.userId;

  it('runs a direct room turn as the Forge user the speaker resolves to', async () => {
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'speaker-user-9' });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(principalUsed()).toBe('speaker-user-9');
  });

  it('runs a group room turn as the organization creator and resolves no speaker at all', async () => {
    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'group');

    expect(principalUsed()).toBe('user-1');
    expect(resolveSpeaker).not.toHaveBeenCalled();
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

  it('replies to an unlinked direct speaker with the refusal and the step that links them', async () => {
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: { code: 'SPEAKER_UNLINKED', message: 'unlinked' },
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'direct');

    const [rid, text] = ac.client.sendMessage.mock.calls[0] as [string, string];
    expect(rid).toBe('room-1');
    expect(text).toContain('link-yourself-here');
  });

  it('carries a non-unlinked refusal own message rather than rewording it', async () => {
    resolveSpeaker.mockResolvedValue({
      linked: false,
      refusal: { code: 'SPEAKER_SOURCE_UNKNOWN', message: 'that channel is not one Forge knows' },
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'direct');

    const [, text] = ac.client.sendMessage.mock.calls[0] as [string, string];
    expect(text).toBe('that channel is not one Forge knows');
  });

  it('screens a direct room reply with the same output guard a group reply gets', async () => {
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'speaker-user-9' });

    await handle(makeAc(), ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(screenStakeholderReply).toHaveBeenCalled();
  });

  it('tells a direct speaker the server address cannot be read as an identity', async () => {
    const ac = { ...makeAc(), serverUrl: 'https://broken.example.co' };

    await handle(ac, ROUTE, MESSAGE, 'conn-1', 'direct');

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    const [, text] = ac.client.sendMessage.mock.calls[0] as [string, string];
    expect(text).toContain('broken.example.co');
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

// cm:why the four steps are ordered so a routeless room costs no round trip and an unmentioned group message never occupies a tracker entry it would evict a real mention with (ISS-987 criteria 10-12)
describe('connection-manager routing order', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: null }]);
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
    resolveRoomShape.mockResolvedValue('group');
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

  it('keeps an unmentioned group message out of the duplicate-delivery tracker', async () => {
    const ac = connect(new Map([['room-1', ROUTE]]));

    await routeMessage('conn-1', { ...MESSAGE, mentions: ['someone-else'] });

    expect(ac.seenMessage).not.toHaveBeenCalled();
  });

  it('reaches the tracker for a message it will handle', async () => {
    const ac = connect(new Map([['room-1', ROUTE]]));

    await routeMessage('conn-1', MESSAGE);

    expect(ac.seenMessage).toHaveBeenCalledWith('msg-1');
  });

  it('swallows a re-emitted message id in a direct room', async () => {
    resolveRoomShape.mockResolvedValue('direct');
    resolveSpeaker.mockResolvedValue({ linked: true, userId: 'speaker-user-9' });
    runExternalChatTurn.mockResolvedValue({
      sessionId: 's',
      reply: 'an answer',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });
    const seen = new Set<string>();
    const ac = connect(new Map([['room-1', ROUTE]]), (id: string) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });

    const unaddressed = { ...MESSAGE, rid: 'room-1', mentions: [] };
    await routeMessage('conn-1', unaddressed);
    await routeMessage('conn-1', unaddressed);
    // cm:why `route` hands the turn off with `void this.handle(...)`, so awaiting it settles the ROUTING and not the turn — without a macrotask flush this asserts on a turn that has not started
    await new Promise((resolve) => setImmediate(resolve));

    expect(ac.seenMessage).toHaveBeenCalledTimes(2);
    expect(runExternalChatTurn).toHaveBeenCalledTimes(1);
  });

  it('refuses a message whose room shape does not resolve, and runs no turn', async () => {
    resolveRoomShape.mockResolvedValue(null);
    const ac = connect(new Map([['room-1', ROUTE]]));

    await routeMessage('conn-1', MESSAGE);

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(ac.seenMessage).not.toHaveBeenCalled();
    expect(ac.client.sendMessage).not.toHaveBeenCalled();
  });
});
