import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the ISS-675 escalation wiring inside `handle()` — the escalate
// tool call must short-circuit the normal verify/reply path with the right
// fixed reply, and dedup must not spawn a second concurrent escalation. Heavy
// dependencies (registry/embeddings graph, RC REST/DDP) are stubbed so this
// stays a fast, hermetic unit suite; `handle()` is private, invoked via a
// loose cast (TS `private` is compile-time only).

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
vi.mock('../../chat/external-chat.js', () => ({
  runExternalChatTurn: (...args: unknown[]) => runExternalChatTurn(...args),
}));

vi.mock('../../chat/tools/registry.js', () => ({
  buildProjectToolset: () => ({ tools: [], execute: async () => '' }),
}));

vi.mock('../../chat/tools/external-mcp.js', () => ({
  buildExternalMcpToolsets: async () => ({ toolsets: [], dispose: async () => {} }),
}));

vi.mock('./context.js', () => ({
  buildConversationContext: async () => '',
  buildRocketChatHistoryToolset: () => ({ tools: [], execute: async () => '' }),
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

vi.mock('../store.js', () => ({
  decryptConnectionSecrets: vi.fn(),
  listBindingsForConnection: vi.fn(async () => []),
}));

const { rocketChatManager } = await import('./connection-manager.js');

interface Loose {
  handle(ac: unknown, route: unknown, m: unknown, connectionId: string): Promise<void>;
}
const handle = (rocketChatManager as unknown as Loose).handle.bind(rocketChatManager);

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
};

describe('connection-manager escalation wiring', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: '/repo' }]);
    runExternalChatTurn.mockReset();
    startEscalation.mockReset();
    startAgentChat.mockReset();
    screenStakeholderReply.mockReset();
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
  });

  it('posts the ACK and invokes startEscalation when the model calls escalate(); skips the normal reply', async () => {
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'chat-session-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: true, sessionId: 'escalation-session-1' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(startEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        connectionId: 'conn-1',
        rid: 'room-1',
        botName: 'Babo',
        question: 'How does the pipeline work?',
      }),
    );
    expect(ac.client.sendMessage).toHaveBeenCalledWith('room-1', 'ACK:Babo', undefined);
    // The escalate branch returns before reaching the output-guard verify step.
    expect(screenStakeholderReply).not.toHaveBeenCalled();
  });

  it('replies with the dedup message and does not double-dispatch on a second in-flight escalation', async () => {
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'chat-session-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: false, reason: 'deduped' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(ac.client.sendMessage).toHaveBeenCalledWith('room-1', 'DEDUP:Babo', undefined);
  });

  it('replies with the no-device message when no runner is available', async () => {
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'chat-session-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: false, reason: 'no-device' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(ac.client.sendMessage).toHaveBeenCalledWith('room-1', 'NO_DEVICE:Babo', undefined);
  });

  it('sends nothing over DDP on dispatch-failed — the completion bridge already delivers the fallback', async () => {
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'chat-session-1',
      reply: '',
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [{ name: 'escalate', arguments: '{"question":"How does the pipeline work?"}' }],
    });
    startEscalation.mockResolvedValue({ started: false, reason: 'dispatch-failed' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(ac.client.sendMessage).not.toHaveBeenCalled();
  });

  it('takes the normal verify/reply path (not escalation) when the model answers without escalating', async () => {
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'chat-session-1',
      reply: 'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(startEscalation).not.toHaveBeenCalled();
    expect(screenStakeholderReply).toHaveBeenCalled();
    expect(ac.client.sendMessage).toHaveBeenCalledWith(
      'room-1',
      'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      undefined,
    );
  });
});

describe('connection-manager ISS-727 answer-mode routing', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    runExternalChatTurn.mockReset();
    startAgentChat.mockReset();
    screenStakeholderReply.mockReset();
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
  });

  it("mode='agent' routes to startAgentChat and skips the fast turn entirely", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: true, sessionId: 'agent-session-1' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(startAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        connectionId: 'conn-1',
        rid: 'room-1',
        botName: 'Babo',
        message: 'How does the pipeline work?',
        askedByUsername: 'alice',
        persona: expect.any(String),
      }),
    );
    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(ac.client.sendMessage).toHaveBeenCalledWith('room-1', 'AGENT_ACK:Babo', undefined);
  });

  it("mode='agent' replies with the dedup message on an in-flight agent-chat turn", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: false, reason: 'deduped' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(ac.client.sendMessage).toHaveBeenCalledWith('room-1', 'AGENT_DEDUP:Babo', undefined);
  });

  it("mode='agent' replies with the no-device message when no runner is available", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: false, reason: 'no-device' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(ac.client.sendMessage).toHaveBeenCalledWith('room-1', 'AGENT_NO_DEVICE:Babo', undefined);
  });

  it("mode='agent' sends nothing over DDP on dispatch-failed — the completion bridge delivers the fallback", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'agent' }, repoPath: '/repo' },
    ]);
    startAgentChat.mockResolvedValue({ started: false, reason: 'dispatch-failed' });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(ac.client.sendMessage).not.toHaveBeenCalled();
  });

  it('absent answerMode (null agentConfig) runs the existing fast path unchanged — regression guard', async () => {
    selectLimit.mockResolvedValue([{ agentConfig: null, repoPath: '/repo' }]);
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'chat-session-1',
      reply: 'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(startAgentChat).not.toHaveBeenCalled();
    expect(runExternalChatTurn).toHaveBeenCalled();
  });

  it("mode='fast' (explicit) runs the existing fast path unchanged — regression guard", async () => {
    selectLimit.mockResolvedValue([
      { agentConfig: { rocketChatAnswerMode: 'fast' }, repoPath: '/repo' },
    ]);
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'chat-session-1',
      reply: 'Đơn hàng của bạn đã xử lý xong.', // i18n-allow: a plain-language bot reply exercised by the guard
      terminal: 'done',
      error: null,
      iterations: 1,
      toolCalls: [],
    });

    const ac = makeAc();
    await handle(ac, ROUTE, MESSAGE, 'conn-1');

    expect(startAgentChat).not.toHaveBeenCalled();
    expect(runExternalChatTurn).toHaveBeenCalled();
  });
});
