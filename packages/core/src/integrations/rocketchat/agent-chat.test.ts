import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the ISS-727 `agent`-mode dispatcher — dedup, device
// resolution, and the dispatch-failure safety net. Mirrors
// `escalation.test.ts` exactly since `agent-chat.ts` reuses the same
// chat-turn machinery.

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));

const createChatSessionRow = vi.fn();
const dispatchChatTurn = vi.fn();
const resolveChatDevice = vi.fn();
vi.mock('../../agent-sessions/chat-turn.js', () => ({
  createChatSessionRow: (...args: unknown[]) => createChatSessionRow(...args),
  dispatchChatTurn: (...args: unknown[]) => dispatchChatTurn(...args),
  resolveChatDevice: (...args: unknown[]) => resolveChatDevice(...args),
}));

const applyKernelTransition = vi.fn();
vi.mock('../../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyKernelTransition(...args),
}));

const findAvailableDeviceForProject = vi.fn();
vi.mock('../../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (...args: unknown[]) => findAvailableDeviceForProject(...args),
}));

const postRoomMessage = vi.fn();
vi.mock('./rest-client.js', () => ({
  postRoomMessage: (...args: unknown[]) => postRoomMessage(...args),
}));

const resolveRoomPostAuth = vi.fn();
vi.mock('./room-delivery.js', () => ({
  resolveRoomPostAuth: (...args: unknown[]) => resolveRoomPostAuth(...args),
}));

const {
  AGENT_CHAT_ACK,
  AGENT_CHAT_ACK_DELAY_MS,
  buildAgentChatPrompt,
  hasInFlightAgentChat,
  redispatchAgentChatSessionOnFailover,
  scheduleDelayedAck,
  startAgentChat,
} = await import('./agent-chat.js');

const BASE_ARGS = {
  projectId: 'proj-1',
  project: { id: 'proj-1', slug: 'proj', repoPath: '/repo' },
  connectionId: 'conn-1',
  rid: 'room-1',
  tmid: undefined,
  botName: 'Babo',
  message: 'How does the pipeline dispatcher work?',
  askedByUsername: 'alice',
  persona: 'PERSONA',
  conversationContext: 'earlier discussion…',
};

describe('hasInFlightAgentChat', () => {
  beforeEach(() => {
    selectLimit.mockReset();
  });

  it('is true when a running agent-chat session exists for the room', async () => {
    selectLimit.mockResolvedValue([{ id: 'session-1' }]);
    await expect(hasInFlightAgentChat('proj-1', 'room-1')).resolves.toBe(true);
  });

  it('is false when no row matches', async () => {
    selectLimit.mockResolvedValue([]);
    await expect(hasInFlightAgentChat('proj-1', 'room-1')).resolves.toBe(false);
  });
});

describe('startAgentChat', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    createChatSessionRow.mockReset();
    dispatchChatTurn.mockReset();
    resolveChatDevice.mockReset();
    applyKernelTransition.mockReset();
  });

  it('dedupes against an in-flight agent-chat turn for the same room without creating a session', async () => {
    selectLimit.mockResolvedValue([{ id: 'existing-session' }]);
    const result = await startAgentChat(BASE_ARGS);
    expect(result).toEqual({ started: false, reason: 'deduped' });
    expect(resolveChatDevice).not.toHaveBeenCalled();
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('reports no-device without creating a session when no runner is available', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: null, isLocal: false });
    const result = await startAgentChat(BASE_ARGS);
    expect(result).toEqual({ started: false, reason: 'no-device' });
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('creates a system session pinned to the product lens and dispatches the agent-chat prompt', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: 'device-1', isLocal: false });
    createChatSessionRow.mockResolvedValue({ id: 'session-1', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-1' });

    const result = await startAgentChat(BASE_ARGS);

    expect(result).toEqual({ started: true, sessionId: 'session-1' });
    expect(createChatSessionRow).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        runKind: 'system',
        metadata: expect.objectContaining({
          agentChat: expect.objectContaining({
            connectionId: 'conn-1',
            rid: 'room-1',
            botName: 'Babo',
            question: 'How does the pipeline dispatcher work?',
            deliveredAt: null,
          }),
          lensOverride: ['product'],
        }),
      }),
    );
    expect(dispatchChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        forceLenses: ['product'],
        broadcastEvent: 'agent-session.created',
      }),
    );
    expect(applyKernelTransition).not.toHaveBeenCalled();
  });

  it('marks the session failed via applyKernelTransition when the dispatch throws, so the bridge still fires', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: 'device-1', isLocal: false });
    createChatSessionRow.mockResolvedValue({ id: 'session-1', status: 'idle' });
    dispatchChatTurn.mockRejectedValue(new Error('ws publish failed'));
    applyKernelTransition.mockResolvedValue([{ id: 'session-1', status: 'failed' }]);

    const result = await startAgentChat(BASE_ARGS);

    expect(result).toEqual({ started: false, reason: 'dispatch-failed' });
    expect(applyKernelTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entity: 'session',
        to: 'failed',
        reason: 'ws-publish-failed',
      }),
    );
  });
});

describe('redispatchAgentChatSessionOnFailover', () => {
  function makeSession(overrides: Record<string, unknown> = {}) {
    return {
      id: 'session-1',
      projectId: 'proj-1',
      userId: null,
      deviceId: 'device-1',
      title: 'Chat: How does X work?',
      failureReason: 'no_client_ack',
      messages: [{ role: 'user', content: 'the built agent-chat prompt' }],
      metadata: {
        agentChat: {
          connectionId: 'conn-1',
          rid: 'room-1',
          tmid: null,
          botName: 'Babo',
          askedByUsername: 'alice',
          question: 'How does X work?',
          deliveredAt: '2026-01-01T00:00:00.000Z',
        },
      },
      ...overrides,
    } as never;
  }

  beforeEach(() => {
    selectLimit.mockReset();
    createChatSessionRow.mockReset();
    dispatchChatTurn.mockReset();
    findAvailableDeviceForProject.mockReset();
  });

  it('reports not-agent-chat for a session with no agentChat metadata', async () => {
    const result = await redispatchAgentChatSessionOnFailover(makeSession({ metadata: {} }));
    expect(result).toEqual({ ok: false, status: 'not-agent-chat' });
    expect(findAvailableDeviceForProject).not.toHaveBeenCalled();
  });

  it('is exhausted past MAX_AGENT_CHAT_FAILOVERS (2)', async () => {
    const result = await redispatchAgentChatSessionOnFailover(
      makeSession({
        metadata: {
          agentChat: {
            connectionId: 'conn-1',
            rid: 'room-1',
            botName: 'Babo',
            deliveredAt: null,
            failover: { attempt: 2, triedDeviceIds: ['device-1', 'device-2'] },
          },
        },
      }),
    );
    expect(result).toEqual({ ok: false, status: 'exhausted' });
    expect(findAvailableDeviceForProject).not.toHaveBeenCalled();
  });

  it('reports no-prompt when the session carries no reusable user message', async () => {
    const result = await redispatchAgentChatSessionOnFailover(makeSession({ messages: [] }));
    expect(result).toEqual({ ok: false, status: 'no-prompt' });
  });

  it('reports no-device when no healthy runner is available', async () => {
    findAvailableDeviceForProject.mockResolvedValue(null);
    const result = await redispatchAgentChatSessionOnFailover(makeSession());
    expect(result).toEqual({ ok: false, status: 'no-device' });
    expect(findAvailableDeviceForProject).toHaveBeenCalledWith('proj-1', {
      excludeDeviceIds: ['device-1'],
    });
  });

  it('excludes every device already tried across a bumped failover chain', async () => {
    findAvailableDeviceForProject.mockResolvedValue(null);
    await redispatchAgentChatSessionOnFailover(
      makeSession({
        deviceId: 'device-2',
        metadata: {
          agentChat: {
            connectionId: 'conn-1',
            rid: 'room-1',
            botName: 'Babo',
            deliveredAt: null,
            failover: { attempt: 1, triedDeviceIds: ['device-1'] },
          },
        },
      }),
    );
    expect(findAvailableDeviceForProject).toHaveBeenCalledWith('proj-1', {
      excludeDeviceIds: ['device-1', 'device-2'],
    });
  });

  it('re-dispatches to a healthy runner, carrying the bumped failover chain in metadata', async () => {
    selectLimit.mockResolvedValue([{ id: 'proj-1', slug: 'proj', repoPath: '/repo' }]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    createChatSessionRow.mockResolvedValue({ id: 'session-2', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-2' });

    const result = await redispatchAgentChatSessionOnFailover(makeSession());

    expect(result).toEqual({
      ok: true,
      status: 'redispatched',
      sessionId: 'session-2',
      deviceId: 'device-3',
    });
    expect(createChatSessionRow).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        runKind: 'system',
        metadata: expect.objectContaining({
          agentChat: expect.objectContaining({
            rid: 'room-1',
            deliveredAt: null,
            failover: { attempt: 1, triedDeviceIds: ['device-1'] },
          }),
        }),
      }),
    );
    expect(dispatchChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'the built agent-chat prompt',
        client: { deviceId: 'device-3', isLocal: false, migrated: false },
        broadcastEvent: 'agent-session.created',
      }),
    );
  });

  it('reports error when the project row is missing', async () => {
    selectLimit.mockResolvedValue([]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    const result = await redispatchAgentChatSessionOnFailover(makeSession());
    expect(result).toEqual({ ok: false, status: 'error' });
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('reports error when the re-dispatch throws', async () => {
    selectLimit.mockResolvedValue([{ id: 'proj-1', slug: 'proj', repoPath: '/repo' }]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    createChatSessionRow.mockResolvedValue({ id: 'session-2', status: 'idle' });
    dispatchChatTurn.mockRejectedValue(new Error('ws publish failed'));

    const result = await redispatchAgentChatSessionOnFailover(makeSession());
    expect(result).toEqual({ ok: false, status: 'error' });
  });
});

describe('buildAgentChatPrompt', () => {
  it('includes the persona, conversation context, and the user message', () => {
    const prompt = buildAgentChatPrompt({
      persona: 'PERSONA-TEXT',
      conversationContext: 'earlier discussion…',
      message: 'How does X work?',
      askedByUsername: 'alice',
    });
    expect(prompt).toContain('PERSONA-TEXT');
    expect(prompt).toContain('earlier discussion…');
    expect(prompt).toContain('@alice asks');
    expect(prompt).toContain('How does X work?');
  });

  it('instructs the model that this reply is delivered verbatim, no fenced JSON', () => {
    const prompt = buildAgentChatPrompt({ persona: 'P', message: 'hi' });
    expect(prompt).toMatch(/delivered to the room verbatim/);
    expect(prompt).toMatch(/No fenced JSON/);
  });

  it('omits the conversation-context section when none is seeded', () => {
    const prompt = buildAgentChatPrompt({ persona: 'P', message: 'hi' });
    expect(prompt).not.toContain('Conversation context');
  });
});

describe('scheduleDelayedAck', () => {
  const ACK_ARGS = {
    sessionId: 'session-1',
    connectionId: 'conn-1',
    rid: 'room-1',
    tmid: null as string | null,
    botName: 'Babo',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    selectLimit.mockReset();
    postRoomMessage.mockReset();
    resolveRoomPostAuth.mockReset();
    resolveRoomPostAuth.mockResolvedValue({
      serverUrl: 'https://rc.example',
      authToken: 'tok',
      userId: 'u1',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not post before the delay elapses', async () => {
    selectLimit.mockResolvedValue([{ status: 'running', metadata: { agentChat: { deliveredAt: null } } }]);
    scheduleDelayedAck(ACK_ARGS);
    await vi.advanceTimersByTimeAsync(AGENT_CHAT_ACK_DELAY_MS - 1000);
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it('posts the interim ack when the turn is still running and undelivered after the delay', async () => {
    selectLimit.mockResolvedValue([{ status: 'running', metadata: { agentChat: { deliveredAt: null } } }]);
    scheduleDelayedAck(ACK_ARGS);
    await vi.advanceTimersByTimeAsync(AGENT_CHAT_ACK_DELAY_MS);
    expect(postRoomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://rc.example' }),
      'room-1',
      AGENT_CHAT_ACK('Babo'),
      undefined,
    );
  });

  it('posts the interim ack to the thread when a tmid is set', async () => {
    selectLimit.mockResolvedValue([{ status: 'running', metadata: { agentChat: { deliveredAt: null } } }]);
    scheduleDelayedAck({ ...ACK_ARGS, tmid: 'thread-1' });
    await vi.advanceTimersByTimeAsync(AGENT_CHAT_ACK_DELAY_MS);
    expect(postRoomMessage).toHaveBeenCalledWith(
      expect.anything(),
      'room-1',
      AGENT_CHAT_ACK('Babo'),
      'thread-1',
    );
  });

  it('does NOT post when the turn already finished (fast case — answer landed first)', async () => {
    selectLimit.mockResolvedValue([{ status: 'completed', metadata: { agentChat: { deliveredAt: null } } }]);
    scheduleDelayedAck(ACK_ARGS);
    await vi.advanceTimersByTimeAsync(AGENT_CHAT_ACK_DELAY_MS);
    expect(postRoomMessage).not.toHaveBeenCalled();
    expect(resolveRoomPostAuth).not.toHaveBeenCalled();
  });

  it('does NOT post when the answer was already delivered (deliveredAt stamped)', async () => {
    selectLimit.mockResolvedValue([
      { status: 'running', metadata: { agentChat: { deliveredAt: '2026-07-21T07:00:00.000Z' } } },
    ]);
    scheduleDelayedAck(ACK_ARGS);
    await vi.advanceTimersByTimeAsync(AGENT_CHAT_ACK_DELAY_MS);
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it('does NOT post when the session row is gone', async () => {
    selectLimit.mockResolvedValue([]);
    scheduleDelayedAck(ACK_ARGS);
    await vi.advanceTimersByTimeAsync(AGENT_CHAT_ACK_DELAY_MS);
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it('swallows a missing-connection resolve (no throw, no post)', async () => {
    selectLimit.mockResolvedValue([{ status: 'running', metadata: { agentChat: { deliveredAt: null } } }]);
    resolveRoomPostAuth.mockResolvedValue(null);
    scheduleDelayedAck(ACK_ARGS);
    await vi.advanceTimersByTimeAsync(AGENT_CHAT_ACK_DELAY_MS);
    expect(postRoomMessage).not.toHaveBeenCalled();
  });
});
