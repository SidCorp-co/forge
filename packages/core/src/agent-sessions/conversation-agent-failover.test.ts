// The failover chain of a runner-hosted conversation turn: another box for a
// turn whose runner failed on infrastructure, and the bounds on trying.
//
// Its own file rather than a describe inside `conversation-agent.test.ts`, for
// the size budget (ISS-1039). The seam is the code's: everything here runs after
// a turn has gone terminal and the bridge has claimed its delivery.

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { redispatchConversationAgentTurn } = await import('./conversation-agent-failover.js');

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

describe('redispatchConversationAgentTurn', () => {
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
        conversationAgent: {
          venue: VENUE,
          conversationId: 'conv-1',
          windowId: 'win-1',
          deliveryKey: 'key-1',
          handleName: 'Babo',
          askedByLabel: '@alice',
          question: 'How does X work?',
          door: 'agent-chat-completion',
          replies: REPLIES,
          ackAfterMs: ACK_DELAY_MS,
          deliveredAt: '2026-01-01T00:00:00.000Z',
          failure: null,
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
    applyKernelTransition.mockReset();
  });

  it('reports not-a-conversation-turn for a session carrying no conversation marker', async () => {
    const result = await redispatchConversationAgentTurn(makeSession({ metadata: {} }));
    expect(result).toEqual({ ok: false, status: 'not-a-conversation-turn' });
    expect(findAvailableDeviceForProject).not.toHaveBeenCalled();
  });

  it('is exhausted past the two-failover bound', async () => {
    const result = await redispatchConversationAgentTurn(
      makeSession({
        metadata: {
          conversationAgent: {
            venue: VENUE,
            conversationId: 'conv-1',
            windowId: 'win-1',
            deliveryKey: 'key-1',
            handleName: 'Babo',
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
    const result = await redispatchConversationAgentTurn(makeSession({ messages: [] }));
    expect(result).toEqual({ ok: false, status: 'no-prompt' });
  });

  it('reports no-device when no healthy runner is available', async () => {
    findAvailableDeviceForProject.mockResolvedValue(null);
    const result = await redispatchConversationAgentTurn(makeSession());
    expect(result).toEqual({ ok: false, status: 'no-device' });
    expect(findAvailableDeviceForProject).toHaveBeenCalledWith('proj-1', {
      excludeDeviceIds: ['device-1'],
    });
  });

  it('excludes every device already tried across a bumped failover chain', async () => {
    findAvailableDeviceForProject.mockResolvedValue(null);
    await redispatchConversationAgentTurn(
      makeSession({
        deviceId: 'device-2',
        metadata: {
          conversationAgent: {
            venue: VENUE,
            conversationId: 'conv-1',
            windowId: 'win-1',
            deliveryKey: 'key-1',
            handleName: 'Babo',
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
});

describe('redispatchConversationAgentTurn \u00b7 the re-dispatch itself', () => {
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
        conversationAgent: {
          venue: VENUE,
          conversationId: 'conv-1',
          windowId: 'win-1',
          deliveryKey: 'key-1',
          handleName: 'Babo',
          askedByLabel: '@alice',
          question: 'How does X work?',
          door: 'agent-chat-completion',
          replies: REPLIES,
          ackAfterMs: ACK_DELAY_MS,
          deliveredAt: '2026-01-01T00:00:00.000Z',
          failure: null,
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
    applyKernelTransition.mockReset();
  });

  it('re-dispatches to a healthy runner, carrying the bumped failover chain in metadata', async () => {
    selectLimit.mockResolvedValue([{ id: 'proj-1', slug: 'proj', repoPath: '/repo' }]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    createChatSessionRow.mockResolvedValue({ id: 'session-2', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-2' });

    const result = await redispatchConversationAgentTurn(makeSession());

    expect(result).toEqual({ ok: true, sessionId: 'session-2', deviceId: 'device-3' });
    expect(createChatSessionRow).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        runKind: 'system',
        metadata: expect.objectContaining({
          conversationAgent: expect.objectContaining({
            venue: VENUE,
            windowId: 'win-1',
            deliveredAt: null,
            failure: null,
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
    expect(loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        fromDeviceId: 'device-1',
        toDeviceId: 'device-3',
        failureReason: 'no_client_ack',
      }),
      'conversation-agent failover: re-dispatched to another runner',
    );
  });

  it('schedules the interim ack for the retry session, through the venue own transport', async () => {
    vi.useFakeTimers();
    selectLimit.mockResolvedValueOnce([{ id: 'proj-1', slug: 'proj', repoPath: '/repo' }]);
    selectLimit.mockResolvedValueOnce([
      { status: 'running', metadata: { conversationAgent: { ...MARKER, deliveredAt: null } } },
    ]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    createChatSessionRow.mockResolvedValue({ id: 'session-2', status: 'idle' });
    dispatchChatTurn.mockResolvedValue({ id: 'session-2' });
    deliver.mockClear();

    await redispatchConversationAgentTurn(makeSession());

    await vi.runAllTimersAsync();

    expect(deliver).toHaveBeenCalledWith(VENUE, expect.objectContaining({ text: ACK }));
    vi.useRealTimers();
  });

  it('reports error when the project row is missing', async () => {
    selectLimit.mockResolvedValue([]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    const result = await redispatchConversationAgentTurn(makeSession());
    expect(result).toEqual({ ok: false, status: 'error' });
    expect(createChatSessionRow).not.toHaveBeenCalled();
  });

  it('reports error, marks the retry session failed, and pre-stamps deliveredAt so the bridge short-circuits (no double fallback)', async () => {
    selectLimit.mockResolvedValue([{ id: 'proj-1', slug: 'proj', repoPath: '/repo' }]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    createChatSessionRow.mockResolvedValue({
      id: 'session-2',
      status: 'idle',
      metadata: { conversationAgent: { ...MARKER, deliveredAt: null } },
    });
    dispatchChatTurn.mockRejectedValue(new Error('ws publish failed'));
    applyKernelTransition.mockResolvedValue([{ id: 'session-2', status: 'failed' }]);

    const result = await redispatchConversationAgentTurn(makeSession());
    expect(result).toEqual({ ok: false, status: 'error' });
    expect(applyKernelTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entity: 'session',
        to: 'failed',
        reason: 'ws-publish-failed',
        set: expect.objectContaining({
          metadata: expect.objectContaining({
            conversationAgent: expect.objectContaining({ deliveredAt: expect.any(String) }),
          }),
        }),
      }),
    );
  });

  it('does not mark the retry session failed when createChatSessionRow itself throws (nothing to mark)', async () => {
    selectLimit.mockResolvedValue([{ id: 'proj-1', slug: 'proj', repoPath: '/repo' }]);
    findAvailableDeviceForProject.mockResolvedValue('device-3');
    createChatSessionRow.mockRejectedValue(new Error('insert failed'));

    const result = await redispatchConversationAgentTurn(makeSession());
    expect(result).toEqual({ ok: false, status: 'error' });
    expect(applyKernelTransition).not.toHaveBeenCalled();
  });
});
