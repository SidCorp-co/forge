// What a person is told a runner-hosted turn is doing, and what the recovery
// path reads as a handoff.
//
// Both are reads over one table, and both were wrong in the same direction: they
// answered from something core wrote at dispatch time rather than from evidence
// that the thing had happened. A turn read `running` before any box had it, and
// `delivered` before any answer existed — and a session created and never
// dispatched read as a window already handed off. Each case here is one of those
// (ISS-1039, commit consult F1, F2, F6).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit, then: undefined }));
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
vi.mock('../lifecycle/transition.js', () => ({ applyKernelTransition: vi.fn() }));
vi.mock('./chat-turn.js', () => ({
  createChatSessionRow: vi.fn(),
  dispatchChatTurn: vi.fn(),
  resolveChatDevice: vi.fn(),
}));
vi.mock('../conversations/ports.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  conversationTransport: vi.fn(() => ({ deliver: vi.fn() })),
}));

const { conversationAgentTurnForWindow, readConversationAgentTurns } = await import(
  './conversation-agent.js'
);

const VENUE = {
  adapter: 'web' as const,
  externalId: 'v1',
  shape: 'direct' as const,
  projectId: 'proj-1',
};

const marker = (over: Record<string, unknown> = {}) => ({
  conversationAgent: {
    venue: VENUE,
    conversationId: 'conv-1',
    windowId: 'win-1',
    deliveryKey: 'key-1',
    handleName: 'Forge',
    question: 'which file?',
    askedByLabel: 'Ada',
    door: 'web-agent-completion',
    replies: { dedup: 'd', noDevice: 'n', failed: 'f', ack: null },
    ackAfterMs: null,
    claimedAt: null,
    deliveredAt: null,
    failure: null,
    ...over,
  },
});

/** One session row, as the reader selects it. */
const row = (over: Record<string, unknown> = {}) => ({
  id: 'session-1',
  status: 'running',
  runtimeState: null,
  metadata: marker(),
  createdAt: new Date('2026-09-17T00:00:00.000Z'),
  ...over,
});

function served(rows: unknown[]) {
  selectWhere.mockReturnValueOnce(rows as never);
  return readConversationAgentTurns('conv-1');
}

beforeEach(() => {
  selectLimit.mockReset();
  selectWhere.mockReset();
  selectWhere.mockReturnValue({ limit: selectLimit } as never);
});

describe('what a turn is read as', () => {
  it('is dispatched while the session is running and no box has reported in', async () => {
    expect((await served([row()]))[0]?.state).toBe('dispatched');
  });

  it('is running once the runner has written a runtime state of its own', async () => {
    expect((await served([row({ runtimeState: 'working' })]))[0]?.state).toBe('running');
  });

  it('is still running while the bridge holds the claim and has delivered nothing', async () => {
    const claimed = row({
      status: 'completed',
      metadata: marker({ claimedAt: new Date().toISOString() }),
    });
    expect((await served([claimed]))[0]?.state).toBe('running');
  });

  it('is delivered once the answer is stamped', async () => {
    const done = row({
      status: 'completed',
      metadata: marker({
        claimedAt: '2026-09-17T00:00:01.000Z',
        deliveredAt: '2026-09-17T00:00:02.000Z',
      }),
    });
    expect((await served([done]))[0]?.state).toBe('delivered');
  });

  it('is failed once a claim has been held far past any delivery', async () => {
    const stuck = row({
      status: 'completed',
      metadata: marker({ claimedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    });
    const [turn] = await served([stuck]);
    expect(turn?.state).toBe('failed');
    expect(turn?.reason).toMatch(/interrupted/);
  });

  it('is failed, with the sentence the venue was shown, when the bridge stamped one', async () => {
    const failed = row({
      status: 'failed',
      metadata: marker({
        claimedAt: '2026-09-17T00:00:01.000Z',
        deliveredAt: '2026-09-17T00:00:01.000Z',
        failure: 'nothing to show you',
      }),
    });
    const [turn] = await served([failed]);
    expect(turn?.state).toBe('failed');
    expect(turn?.reason).toBe('nothing to show you');
  });

  it('reads a pre-split row, which carries no claim at all, as delivered', async () => {
    const old = row({
      status: 'completed',
      metadata: marker({ claimedAt: undefined, deliveredAt: '2026-09-16T00:00:00.000Z' }),
    });
    expect((await served([old]))[0]?.state).toBe('delivered');
  });
});

describe('the session a reclaimed window finds', () => {
  it('finds the session once its dispatch was accepted', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'session-1' }]);
    expect(await conversationAgentTurnForWindow('win-1')).toEqual({ sessionId: 'session-1' });
  });
});
