import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the ISS-727 `agent`-mode completion bridge: the CAS
// idempotency stamp (safe to call from both session-terminal writers),
// verbatim delivery of the runner's final reply through the output guard,
// and the room-never-silent fallback paths. Mirrors
// `escalation-bridge.test.ts`'s structure; adjacent modules are mocked
// directly (rather than pulling in their real dependency graphs) exactly
// like that file does for `connection-manager.js`.

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
vi.mock('../../db/client.js', () => ({
  db: { update: vi.fn(() => ({ set: updateSet })) },
}));

const resolveRoomPostAuth = vi.fn();
vi.mock('./room-delivery.js', () => ({
  resolveRoomPostAuth: (...args: unknown[]) => resolveRoomPostAuth(...args),
}));

const screenStakeholderReply = vi.fn();
vi.mock('./reply-screen.js', () => ({
  screenStakeholderReply: (...args: unknown[]) => screenStakeholderReply(...args),
}));

const postRoomMessage = vi.fn();
vi.mock('./rest-client.js', () => ({
  postRoomMessage: (...args: unknown[]) => postRoomMessage(...args),
}));

const extractFinalAssistantText = vi.fn();
vi.mock('./escalation-bridge.js', () => ({
  extractFinalAssistantText: (...args: unknown[]) => extractFinalAssistantText(...args),
}));

const AGENT_CHAT_FALLBACK_REPLY = vi.fn((botName: string) => `FALLBACK(${botName})`);
vi.mock('./agent-chat.js', () => ({
  AGENT_CHAT_FALLBACK_REPLY: (...args: unknown[]) => AGENT_CHAT_FALLBACK_REPLY(...args),
}));

const { deliverAgentChatReplyOnce } = await import('./agent-chat-bridge.js');

const AUTH = { serverUrl: 'https://chat.example.co', authToken: 'tok', userId: 'bot-1' };

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    projectId: 'proj-1',
    status: 'completed',
    messages: [],
    metadata: {
      agentChat: {
        connectionId: 'conn-1',
        rid: 'room-1',
        tmid: null,
        botName: 'Babo',
        askedByUsername: 'alice',
        question: 'How does X work?',
        deliveredAt: null,
      },
    },
    ...overrides,
  } as never;
}

describe('deliverAgentChatReplyOnce', () => {
  beforeEach(() => {
    updateReturning.mockReset();
    resolveRoomPostAuth.mockReset();
    screenStakeholderReply.mockReset();
    postRoomMessage.mockReset();
    extractFinalAssistantText.mockReset();
    AGENT_CHAT_FALLBACK_REPLY.mockClear();
  });

  it('is a no-op for a session with no agentChat metadata', async () => {
    await deliverAgentChatReplyOnce(makeSession({ metadata: {} }));
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('is a no-op when already delivered (deliveredAt already set)', async () => {
    await deliverAgentChatReplyOnce(
      makeSession({
        metadata: {
          agentChat: {
            connectionId: 'c',
            rid: 'r',
            botName: 'Babo',
            deliveredAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('no-ops (does not post) when the CAS loses the race', async () => {
    updateReturning.mockResolvedValue([]); // another caller already claimed it
    await deliverAgentChatReplyOnce(makeSession());
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it('no-ops (does not post) when the connection cannot be resolved', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    resolveRoomPostAuth.mockResolvedValue(null);
    await deliverAgentChatReplyOnce(makeSession());
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it('delivers the runner reply verbatim when the output guard passes', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('Here is the final answer.');
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverAgentChatReplyOnce(makeSession());

    expect(screenStakeholderReply).toHaveBeenCalledWith('proj-1', 'Here is the final answer.', []);
    expect(postRoomMessage).toHaveBeenCalledWith(
      AUTH,
      'room-1',
      'Here is the final answer.',
      undefined,
    );
  });

  it('falls back when the output guard rejects the reply', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('```leaky```');
    screenStakeholderReply.mockResolvedValue({ ok: false, problems: ['leaks a code fence'] });

    await deliverAgentChatReplyOnce(makeSession());

    const [, , postedText] = postRoomMessage.mock.calls[0] as [unknown, unknown, string, unknown];
    expect(postedText).not.toContain('```');
    expect(postedText).toBe('FALLBACK(Babo)');
  });

  it('falls back on a failed/empty session without calling the guard', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    resolveRoomPostAuth.mockResolvedValue(AUTH);

    await deliverAgentChatReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(screenStakeholderReply).not.toHaveBeenCalled();
    expect(postRoomMessage).toHaveBeenCalledWith(AUTH, 'room-1', 'FALLBACK(Babo)', undefined);
  });

  it('posts to the tmid thread when the original message was threaded', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('answer');
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverAgentChatReplyOnce(
      makeSession({
        metadata: {
          agentChat: {
            connectionId: 'conn-1',
            rid: 'room-1',
            tmid: 'thread-1',
            botName: 'Babo',
            deliveredAt: null,
          },
        },
      }),
    );

    expect(postRoomMessage).toHaveBeenCalledWith(AUTH, 'room-1', 'answer', 'thread-1');
  });

  it('room-never-silent: falls back when postRoomMessage throws (swallows the error)', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('answer');
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
    postRoomMessage.mockRejectedValue(new Error('network error'));

    await expect(deliverAgentChatReplyOnce(makeSession())).resolves.toBeUndefined();
  });
});
