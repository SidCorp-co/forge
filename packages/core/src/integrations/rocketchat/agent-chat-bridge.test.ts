import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the ISS-727 `agent`-mode completion bridge: the CAS
// idempotency stamp (safe to call from both session-terminal writers),
// verbatim delivery of the runner's final reply through the output guard,
// and the room-never-silent fallback paths. Mirrors
// `escalation-bridge.test.ts`'s structure; adjacent modules are mocked
// directly (rather than pulling in their real dependency graphs) exactly
// like that file does for `connection-manager.js`.

// cm:why the room-delivery mock below spreads the REAL module, whose graph validates env eagerly at import — without these two stubs the file fails to load rather than failing a test
vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

// cm:why `readRoomReplyMeta` is deliberately NOT stubbed — it is pure, and leaving it real keeps the "is this session ours" marker validation under test; only the DB/network helpers are faked
const claimRoomReplyDelivery = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const resolveRoomPostAuth = vi.fn();
const extractFinalAssistantText = vi.fn();
vi.mock('./room-delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./room-delivery.js')>()),
  claimRoomReplyDelivery: (...args: unknown[]) => claimRoomReplyDelivery(...args),
  resolveRoomPostAuth: (...args: unknown[]) => resolveRoomPostAuth(...args),
  extractFinalAssistantText: (...args: unknown[]) => extractFinalAssistantText(...args),
}));

const screenStakeholderReply = vi.fn();
vi.mock('./reply-screen.js', () => ({
  screenStakeholderReply: (...args: unknown[]) => screenStakeholderReply(...args),
}));

const FIXED_REPLY_CONSTANT = Symbol('fixed-reply-constant');
const sendFixedReply = vi.fn();
vi.mock('./outbound.js', () => ({
  FIXED_REPLY_CONSTANT,
  sendFixedReply: (...args: unknown[]) => sendFixedReply(...args),
}));

const AGENT_CHAT_FALLBACK_REPLY = vi.fn((...args: unknown[]) => `FALLBACK(${String(args[0])})`);
const redispatchAgentChatSessionOnFailover = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('./agent-chat.js', () => ({
  AGENT_CHAT_FALLBACK_REPLY: (...args: unknown[]) => AGENT_CHAT_FALLBACK_REPLY(...args),
  redispatchAgentChatSessionOnFailover: (...args: unknown[]) =>
    redispatchAgentChatSessionOnFailover(...args),
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
    claimRoomReplyDelivery.mockReset();
    resolveRoomPostAuth.mockReset();
    screenStakeholderReply.mockReset();
    sendFixedReply.mockReset();
    extractFinalAssistantText.mockReset();
    AGENT_CHAT_FALLBACK_REPLY.mockClear();
    redispatchAgentChatSessionOnFailover.mockReset();
    redispatchAgentChatSessionOnFailover.mockResolvedValue({ ok: false, status: 'exhausted' });
  });

  it('is a no-op for a session with no agentChat metadata', async () => {
    await deliverAgentChatReplyOnce(makeSession({ metadata: {} }));
    expect(claimRoomReplyDelivery).not.toHaveBeenCalled();
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
    expect(claimRoomReplyDelivery).not.toHaveBeenCalled();
  });

  it('no-ops (does not post) when the CAS loses the race', async () => {
    claimRoomReplyDelivery.mockResolvedValue(false); // another caller already claimed it
    await deliverAgentChatReplyOnce(makeSession());
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  it('no-ops (does not post) when the connection cannot be resolved', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(null);
    await deliverAgentChatReplyOnce(makeSession());
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  it('delivers the runner reply verbatim when the output guard passes', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('Here is the final answer.');
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverAgentChatReplyOnce(makeSession());

    expect(screenStakeholderReply).toHaveBeenCalledWith(
      'proj-1',
      'Here is the final answer.',
      [],
      'legacy-session',
    );
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'Here is the final answer.',
      { ok: true, problems: [] },
    );
  });

  it('threads the transcript tool calls into the output guard (ISS-727 review fix)', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('Created ISS-42 for you.');
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverAgentChatReplyOnce(
      makeSession({
        messages: [
          { type: 'user', content: 'please create an issue' },
          {
            type: 'assistant',
            content: 'Created ISS-42 for you.',
            toolCalls: [{ id: 't1', name: 'forge_issues', input: { action: 'create' } }],
          },
        ],
      }),
    );

    expect(screenStakeholderReply).toHaveBeenCalledWith(
      'proj-1',
      'Created ISS-42 for you.',
      [{ name: 'forge_issues', arguments: JSON.stringify({ action: 'create' }) }],
      'legacy-session',
    );
  });

  it('falls back when the output guard rejects the reply', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('```leaky```');
    screenStakeholderReply.mockResolvedValue({ ok: false, problems: ['leaks a code fence'] });

    await deliverAgentChatReplyOnce(makeSession());

    const [, postedText] = sendFixedReply.mock.calls[0] as [unknown, string];
    expect(postedText).not.toContain('```');
    expect(postedText).toBe('FALLBACK(Babo)');
  });

  it('falls back on a failed/empty session without calling the guard, once failover is exhausted', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    redispatchAgentChatSessionOnFailover.mockResolvedValue({ ok: false, status: 'exhausted' });

    await deliverAgentChatReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(redispatchAgentChatSessionOnFailover).toHaveBeenCalledTimes(1);
    expect(screenStakeholderReply).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });

  it('re-dispatches a failed/transient session to a healthy runner instead of posting the fallback', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    redispatchAgentChatSessionOnFailover.mockResolvedValue({
      ok: true,
      status: 'redispatched',
      sessionId: 'session-2',
      deviceId: 'device-2',
    });

    await deliverAgentChatReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(redispatchAgentChatSessionOnFailover).toHaveBeenCalledTimes(1);
    expect(resolveRoomPostAuth).not.toHaveBeenCalled();
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  it('never retries a user_cancelled session — goes straight to fallback', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);

    await deliverAgentChatReplyOnce(
      makeSession({ status: 'failed', failureReason: 'user_cancelled', messages: [] }),
    );

    expect(redispatchAgentChatSessionOnFailover).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });

  it('never retries a skill_not_synced failure — deterministic, retrying would reproduce the same outcome', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);

    await deliverAgentChatReplyOnce(
      makeSession({ status: 'failed', failureReason: 'skill_not_synced', messages: [] }),
    );

    expect(redispatchAgentChatSessionOnFailover).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });

  it('never retries a ws-publish-failed dispatch failure — deterministic, not an infra routing issue', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);

    await deliverAgentChatReplyOnce(
      makeSession({ status: 'failed', failureReason: 'ws-publish-failed', messages: [] }),
    );

    expect(redispatchAgentChatSessionOnFailover).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });

  it('posts exactly one fallback when failover dispatch throws (dispatch-throw path returns {ok:false,status:error})', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    redispatchAgentChatSessionOnFailover.mockResolvedValue({ ok: false, status: 'error' });

    await deliverAgentChatReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(sendFixedReply).toHaveBeenCalledTimes(1);
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });

  it('never retries a content-side outcome (completed session, output-guard rejected)', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('```leaky```');
    screenStakeholderReply.mockResolvedValue({ ok: false, problems: ['leaks a code fence'] });

    await deliverAgentChatReplyOnce(makeSession({ status: 'completed' }));

    expect(redispatchAgentChatSessionOnFailover).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });

  it('posts to the tmid thread when the original message was threaded', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
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

    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: 'thread-1' },
      'answer',
      { ok: true, problems: [] },
    );
  });

  it('room-never-silent: falls back when sendFixedReply throws (swallows the error)', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('answer');
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
    sendFixedReply.mockRejectedValue(new Error('network error'));

    await expect(deliverAgentChatReplyOnce(makeSession())).resolves.toBeUndefined();
  });
});
