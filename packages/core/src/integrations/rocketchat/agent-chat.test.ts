import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { buildAgentChatPrompt, hasInFlightAgentChat, startAgentChat } = await import(
  './agent-chat.js'
);

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
