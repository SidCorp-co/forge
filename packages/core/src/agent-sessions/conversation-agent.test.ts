// The runner-hosted conversation turn: dedup, device resolution, the
// dispatch-failure safety net, the failover chain, the prompt and the interim
// ack.
//
// Was `integrations/rocketchat/agent-chat.test.ts` until ISS-1039 moved the
// lane off Rocket.Chat's vocabulary. Every case below is the same claim about
// the same machinery, restated about a venue, a window and a delivery key —
// which is the point: the behaviour a room relied on is asserted here, on the
// one lane, rather than once per transport.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(() => ({ from: selectFrom })) },
}));
vi.mock('../ws/server.js', () => ({ roomManager: { publish: vi.fn() } }));
vi.mock('../pipeline/outbox-session.js', () => ({ withActorContext: vi.fn() }));
vi.mock('../pipeline/runs.js', () => ({
  closeOpenRunForIssue: vi.fn(),
  setCurrentStepForOpenIssueRun: vi.fn(),
}));

const computeProjectProgress = vi.fn(async (..._args: unknown[]) => null);
vi.mock('../issues/progress.js', () => ({
  computeProjectProgress: (...args: unknown[]) => computeProjectProgress(...args),
  buildProgressFactsBlock: () => 'PROGRESS FACTS BLOCK',
}));

const createChatSessionRow = vi.fn();
const dispatchChatTurn = vi.fn();
const resolveChatDevice = vi.fn();
vi.mock('./chat-turn.js', () => ({
  createChatSessionRow: (...args: unknown[]) => createChatSessionRow(...args),
  dispatchChatTurn: (...args: unknown[]) => dispatchChatTurn(...args),
  resolveChatDevice: (...args: unknown[]) => resolveChatDevice(...args),
}));

const applyKernelTransition = vi.fn();
vi.mock('../lifecycle/transition.js', () => ({
  applyKernelTransition: (...args: unknown[]) => applyKernelTransition(...args),
}));

const findAvailableDeviceForProject = vi.fn();
vi.mock('../lib/device-pool.js', () => ({
  findAvailableDeviceForProject: (...args: unknown[]) => findAvailableDeviceForProject(...args),
}));

// cm:why the transport REGISTRY is mocked rather than a transport's client: the lane reaches a venue
// through `conversationTransport(adapter).deliver` and knows nothing else about it, so this is the
// whole of what the ack has to be asserted against.
const deliver = vi.fn(async () => ({ messageId: 'm1' }));
vi.mock('../conversations/ports.js', async (orig) => ({
  ...(await orig<typeof import('../conversations/ports.js')>()),
  conversationTransport: () => ({ adapter: 'web', deliver }),
}));

const loggerInfo = vi.fn();
vi.mock('../logger.js', () => ({
  logger: { info: (...args: unknown[]) => loggerInfo(...args), error: vi.fn(), warn: vi.fn() },
}));

const {
  buildConversationAgentPrompt,
  hasInFlightConversationAgentTurn,
  startConversationAgentTurn,
} = await import('./conversation-agent.js');

const VENUE = {
  adapter: 'rocketchat' as const,
  externalId: 'chat.example.com room-1',
  shape: 'direct' as const,
  projectId: 'proj-1',
};

const ACK_DELAY_MS = 2 * 60 * 1000;
const ACK = 'Babo is working on this.';

const REPLIES = {
  dedup: 'already running',
  noDevice: 'no box free',
  failed: 'nothing to show you',
  ack: ACK,
};

/** The stored marker, as `readConversationAgentMeta` needs to be able to read it back. */
const MARKER = {
  venue: VENUE,
  conversationId: 'conv-1',
  windowId: 'win-1',
  deliveryKey: 'key-1',
  handleName: 'Babo',
  question: 'How does X work?',
  askedByLabel: '@alice',
  door: 'agent-chat-completion',
  replies: REPLIES,
  ackAfterMs: ACK_DELAY_MS,
  deliveredAt: null,
  failure: null,
};

const BASE_ARGS = {
  venue: VENUE,
  conversationId: 'conv-1',
  windowId: 'win-1',
  deliveryKey: 'key-1',
  project: { id: 'proj-1', slug: 'proj', repoPath: '/repo' },
  handleName: 'Babo',
  question: 'How does the pipeline dispatcher work?',
  askedByLabel: '@alice',
  persona: 'PERSONA',
  conversationContext: 'earlier discussion…',
  door: 'agent-chat-completion' as const,
  replies: REPLIES,
  ackAfterMs: ACK_DELAY_MS,
  forceLenses: ['product'] as const,
};

describe('hasInFlightConversationAgentTurn', () => {
  beforeEach(() => {
    selectLimit.mockReset();
  });

  it('is true when a running agent-chat session exists for the room', async () => {
    selectLimit.mockResolvedValue([{ id: 'session-1' }]);
    await expect(hasInFlightConversationAgentTurn('proj-1', 'conv-1')).resolves.toBe(true);
  });

  it('is false when no row matches', async () => {
    selectLimit.mockResolvedValue([]);
    await expect(hasInFlightConversationAgentTurn('proj-1', 'conv-1')).resolves.toBe(false);
  });
});

describe('startConversationAgentTurn', () => {
  beforeEach(() => {
    selectLimit.mockReset();
    createChatSessionRow.mockReset();
    dispatchChatTurn.mockReset();
    resolveChatDevice.mockReset();
    applyKernelTransition.mockReset();
  });

  it('dedupes against an in-flight agent-chat turn for the same room without creating a session', async () => {
    selectLimit.mockResolvedValue([{ id: 'existing-session' }]);
    const result = await startConversationAgentTurn(BASE_ARGS);
    expect(result).toEqual({ started: false, reason: 'deduped' });
    expect(resolveChatDevice).not.toHaveBeenCalled();
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('reports no-device without creating a session when no runner is available', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: null, isLocal: false });
    const result = await startConversationAgentTurn(BASE_ARGS);
    expect(result).toEqual({ started: false, reason: 'no-device' });
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('creates a system session carrying the venue, the window and the delivery key, pinned to the caller lens', async () => {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: 'device-1', isLocal: false });
    createChatSessionRow.mockResolvedValue({ id: 'session-1', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-1' });

    const result = await startConversationAgentTurn(BASE_ARGS);

    expect(result).toEqual({ started: true, sessionId: 'session-1' });
    expect(createChatSessionRow).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        runKind: 'system',
        metadata: expect.objectContaining({
          conversationAgent: expect.objectContaining({
            venue: VENUE,
            conversationId: 'conv-1',
            windowId: 'win-1',
            deliveryKey: 'key-1',
            handleName: 'Babo',
            question: 'How does the pipeline dispatcher work?',
            door: 'agent-chat-completion',
            deliveredAt: null,
            failure: null,
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

    const result = await startConversationAgentTurn(BASE_ARGS);

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

describe('buildConversationAgentPrompt', () => {
  it('includes the persona, conversation context, and the user message', () => {
    const prompt = buildConversationAgentPrompt({
      persona: 'PERSONA-TEXT',
      conversationContext: 'earlier discussion…',
      question: 'How does X work?',
      askedByLabel: '@alice',
    });
    expect(prompt).toContain('PERSONA-TEXT');
    expect(prompt).toContain('earlier discussion…');
    expect(prompt).toContain('@alice asks');
    expect(prompt).toContain('How does X work?');
  });

  it('instructs the model that this reply is delivered verbatim, no fenced JSON', () => {
    const prompt = buildConversationAgentPrompt({ persona: 'P', question: 'hi' });
    expect(prompt).toMatch(/delivered to the room verbatim/);
    expect(prompt).toMatch(/No fenced JSON/);
  });

  it('omits the conversation-context section when none is seeded', () => {
    const prompt = buildConversationAgentPrompt({ persona: 'P', question: 'hi' });
    expect(prompt).not.toContain('Conversation context');
  });
});

/**
 * The interim ack, driven through the one door that schedules it.
 */
// cm:guard exercised through `startConversationAgentTurn` and never through an exported scheduler:
// the ack is now the lane's own, and a test that called a scheduler directly would keep passing
// after the dispatch stopped scheduling one (ISS-1039).
describe('the interim ack', () => {
  async function start(overrides: Record<string, unknown> = {}) {
    selectLimit.mockResolvedValue([]);
    resolveChatDevice.mockResolvedValue({ deviceId: 'device-1', isLocal: false, migrated: false });
    createChatSessionRow.mockResolvedValue({ id: 'session-1', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-1' });
    return startConversationAgentTurn({ ...BASE_ARGS, ...overrides });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    selectLimit.mockReset();
    resolveChatDevice.mockReset();
    createChatSessionRow.mockReset();
    dispatchChatTurn.mockReset();
    deliver.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not post before the delay elapses', async () => {
    await start();
    selectLimit.mockResolvedValue([
      { status: 'running', metadata: { conversationAgent: { ...MARKER, deliveredAt: null } } },
    ]);
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS - 1000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('posts it through the venue’s transport when the turn is still running and undelivered', async () => {
    await start();
    selectLimit.mockResolvedValue([
      { status: 'running', metadata: { conversationAgent: { ...MARKER, deliveredAt: null } } },
    ]);
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS);
    expect(deliver).toHaveBeenCalledWith(VENUE, expect.objectContaining({ text: ACK }));
  });

  // cm:guard the common case: the answer usually lands first, and an ack posted after it reads as a
  // second reply to a question already answered.
  it('does NOT post when the turn already finished', async () => {
    await start();
    selectLimit.mockResolvedValue([
      { status: 'completed', metadata: { conversationAgent: { ...MARKER, deliveredAt: null } } },
    ]);
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does NOT post when the answer was already delivered', async () => {
    await start();
    selectLimit.mockResolvedValue([
      {
        status: 'running',
        metadata: {
          conversationAgent: { ...MARKER, deliveredAt: '2026-07-21T07:00:00.000Z' },
        },
      },
    ]);
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does NOT post when the session row is gone', async () => {
    await start();
    selectLimit.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS);
    expect(deliver).not.toHaveBeenCalled();
  });

  // cm:guard criterion 19's other half: the Forge UI prints `dispatched` and `running` on the thread
  // itself, so its caller passes no ack at all — and a lane that posted a default one would put the
  // same fact in the room twice, the second copy indistinguishable from the answer (ISS-1039).
  it('is not scheduled at all when the caller names no ack', async () => {
    await start({ replies: { ...REPLIES, ack: null }, ackAfterMs: null });
    selectLimit.mockResolvedValue([
      { status: 'running', metadata: { conversationAgent: { ...MARKER, deliveredAt: null } } },
    ]);
    await vi.advanceTimersByTimeAsync(ACK_DELAY_MS * 2);
    expect(deliver).not.toHaveBeenCalled();
  });
});
