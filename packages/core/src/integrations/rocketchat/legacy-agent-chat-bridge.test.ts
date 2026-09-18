import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screenPasses } from '../../messaging/screen-passes.fixture.js';

/**
 * ISS-727 — the `agent`-mode completion bridge: its CAS idempotency stamp, the
 * verbatim delivery of a runner's final reply through the output guard, and the
 * room-never-silent fallbacks.
 */
// cm:why adjacent modules are mocked directly rather than by pulling in their real dependency graphs, as `escalation-bridge.test.ts` does for `connection-manager.js`: those graphs validate env eagerly at import.

// cm:why the room-delivery mock below spreads the REAL module, whose graph validates env eagerly at import — without these two stubs the file fails to load rather than failing a test
vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

// cm:why `readRoomReplyMeta` is deliberately NOT stubbed — it is pure, and leaving it real keeps the "is this session ours" marker validation under test; only the DB/network helpers are faked
const claimRoomReplyDelivery = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const resolveRoomPostAuth = vi.fn();
const extractFinalAssistantText = vi.fn();
/** Answers of the successive `roomStillBoundTo` reads; a single `true` unless a case says otherwise. */
let roomBoundSequence: boolean[] = [true];
const roomStillBoundToCalls = vi.fn();
vi.mock('./room-delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./room-delivery.js')>()),
  // cm:why stubbed: this file's fake db answers only the subject's own queries, and the room-is-still-ours check has its cases in room-delivery.test.ts.
  roomStillBoundTo: async () => {
    const n = roomStillBoundToCalls.mock.calls.length;
    roomStillBoundToCalls();
    return roomBoundSequence[n] ?? roomBoundSequence.at(-1) ?? true;
  },
  claimRoomReplyDelivery: (...args: unknown[]) => claimRoomReplyDelivery(...args),
  resolveRoomPostAuth: (...args: unknown[]) => resolveRoomPostAuth(...args),
  extractFinalAssistantText: (...args: unknown[]) => extractFinalAssistantText(...args),
}));

const screenRoomReply = vi.fn();
vi.mock('../../messaging/reply-screen.js', () => ({
  screenReplyAtDoor: (...args: unknown[]) => screenRoomReply(...args),
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

const { deliverLegacyAgentChatReplyOnce } = await import('./legacy-agent-chat-bridge.js');

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

// cm:why the binding stub is reset at module level, not inside either describe: the describe below is at its frozen function budget, and two more lines in its `beforeEach` is what pushed it over (ISS-1001).
beforeEach(() => {
  roomBoundSequence = [true];
  roomStillBoundToCalls.mockReset();
});

const REFUSAL = {
  rule: 'no-developer-detail',
  why: 'leaks a code fence',
  quote: null,
  shape: 'plain language',
  example: 'The fix is in.',
} as const;

function resetAgentChatMocks(): void {
  claimRoomReplyDelivery.mockReset();
  resolveRoomPostAuth.mockReset();
  screenRoomReply.mockReset();
  sendFixedReply.mockReset();
  extractFinalAssistantText.mockReset();
  AGENT_CHAT_FALLBACK_REPLY.mockClear();
  redispatchAgentChatSessionOnFailover.mockReset();
  redispatchAgentChatSessionOnFailover.mockResolvedValue({ ok: false, status: 'exhausted' });
}

describe('deliverLegacyAgentChatReplyOnce', () => {
  beforeEach(resetAgentChatMocks);

  it('is a no-op for a session with no agentChat metadata', async () => {
    await deliverLegacyAgentChatReplyOnce(makeSession({ metadata: {} }));
    expect(claimRoomReplyDelivery).not.toHaveBeenCalled();
  });

  it('is a no-op when already delivered (deliveredAt already set)', async () => {
    await deliverLegacyAgentChatReplyOnce(
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
    claimRoomReplyDelivery.mockResolvedValue(false);
    await deliverLegacyAgentChatReplyOnce(makeSession());
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  it('no-ops (does not post) when the connection cannot be resolved', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(null);
    await deliverLegacyAgentChatReplyOnce(makeSession());
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  it('delivers the runner reply verbatim when the output guard passes', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('Here is the final answer.');
    screenRoomReply.mockImplementation(screenPasses);

    await deliverLegacyAgentChatReplyOnce(makeSession());

    expect(screenRoomReply).toHaveBeenCalledWith('agent-chat-completion', {
      projectId: 'proj-1',
      segments: ['Here is the final answer.'],
      toolCalls: [],
      progress: 'legacy-session',
    });
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'Here is the final answer.',
      // cm:guard the proof NAMES the string being posted, which is the assertion ISS-978 F5 found
      // missing everywhere: `{ ok: true, problems: [] }` was satisfied by any literal and said nothing
      // about which text had been screened.
      { text: 'Here is the final answer.', door: 'agent-chat-completion' },
    );
  });

  it('threads the transcript tool calls into the output guard (ISS-727 review fix)', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('Created ISS-42 for you.');
    screenRoomReply.mockImplementation(screenPasses);

    await deliverLegacyAgentChatReplyOnce(
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

    expect(screenRoomReply).toHaveBeenCalledWith('agent-chat-completion', {
      projectId: 'proj-1',
      segments: ['Created ISS-42 for you.'],
      toolCalls: [{ name: 'forge_issues', arguments: JSON.stringify({ action: 'create' }) }],
      progress: 'legacy-session',
    });
  });

  it('falls back when the output guard rejects the reply', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('```leaky```');
    screenRoomReply.mockResolvedValue({
      ok: false,
      refusals: [{ ...REFUSAL, why: 'leaks a code fence' }],
    });

    await deliverLegacyAgentChatReplyOnce(makeSession());

    const [, postedText] = sendFixedReply.mock.calls[0] as [unknown, string];
    expect(postedText).not.toContain('```');
    expect(postedText).toBe('FALLBACK(Babo)');
  });

  // cm:guard this shim does NOT fail over, and that is the priced half of the `cm:hack` on the
  // bridge list: the redispatch was rebuilt around the venue shape these rows do not carry, so an
  // in-flight legacy session whose runner dies gets the honest fallback rather than another box.
  // The room is still answered, which is the property the shim exists for (ISS-1039).
  it('falls back on a failed/empty session without calling the guard, and never fails over', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);

    await deliverLegacyAgentChatReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(redispatchAgentChatSessionOnFailover).not.toHaveBeenCalled();
    expect(screenRoomReply).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });
});

/**
 * The binding is read twice, and each read answers a question the other cannot. These live in a
 * describe of their own because `deliverLegacyAgentChatReplyOnce` above is at its frozen function budget.
 */
describe('deliverLegacyAgentChatReplyOnce: the room is read again before the post', () => {
  beforeEach(() => {
    claimRoomReplyDelivery.mockReset();
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockReset();
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    screenRoomReply.mockReset();
    screenRoomReply.mockImplementation(screenPasses);
    sendFixedReply.mockReset();
    extractFinalAssistantText.mockReset();
    extractFinalAssistantText.mockReturnValue('answer');
    AGENT_CHAT_FALLBACK_REPLY.mockClear();
    redispatchAgentChatSessionOnFailover.mockReset();
    redispatchAgentChatSessionOnFailover.mockResolvedValue({ ok: false, status: 'exhausted' });
  });

  /** What the room was shown this run — the empty list is a room that saw nothing. */
  const postedTexts = () => sendFixedReply.mock.calls.map((c) => c[1] as string);

  // cm:guard the first read is before the claim, the second immediately before the post, and between them sit a failover redispatch and a screening turn — either of them minutes long, so without the second read the answer they produce is posted into a room that moved (ISS-1001).
  it('shows the room nothing when it is rebound while the fallback is prepared', async () => {
    roomBoundSequence = [true, false];

    await deliverLegacyAgentChatReplyOnce(makeSession({ status: 'failed', failureReason: null }));

    expect(roomStillBoundToCalls.mock.calls).toHaveLength(2);
    expect(postedTexts()).toEqual([]);
  });

  it('shows the room nothing when it is rebound during the screening turn', async () => {
    roomBoundSequence = [true, false];

    await deliverLegacyAgentChatReplyOnce(makeSession());

    expect(screenRoomReply.mock.calls).toHaveLength(1);
    expect(roomStillBoundToCalls.mock.calls).toHaveLength(2);
    expect(postedTexts()).toEqual([]);
  });

  // cm:guard the rebind is terminal for THIS delivery and the claim above is already spent, which is right: the project that would retry it is no longer the room's.
  it('leaves the claim spent rather than re-queueing the answer', async () => {
    roomBoundSequence = [true, false];

    await deliverLegacyAgentChatReplyOnce(makeSession());

    expect(claimRoomReplyDelivery.mock.calls).toHaveLength(1);
  });

  // cm:guard the first read still refuses before any work is spent: a rebound room costs no failover redispatch and no screening turn.
  it('spends no failover and no screening turn when the FIRST read refuses', async () => {
    roomBoundSequence = [false];

    await deliverLegacyAgentChatReplyOnce(makeSession({ status: 'failed', failureReason: null }));

    expect(roomStillBoundToCalls.mock.calls).toHaveLength(1);
    expect(redispatchAgentChatSessionOnFailover.mock.calls).toHaveLength(0);
    expect(screenRoomReply.mock.calls).toHaveLength(0);
    expect(postedTexts()).toEqual([]);
  });

  it('shows the room the answer once when it is bound at both reads', async () => {
    roomBoundSequence = [true, true];

    await deliverLegacyAgentChatReplyOnce(makeSession());

    expect(roomStillBoundToCalls.mock.calls).toHaveLength(2);
    expect(postedTexts()).toEqual(['answer']);
  });
});

describe('deliverLegacyAgentChatReplyOnce: the repair budget this door declares', () => {
  // cm:guard zero repairs is DECLARED at the `agent-chat-completion` door, not absent by omission: the runner session whose final message this carries has already ended, so there is nothing to ask again. If a repair ever appears here it means the door's row changed, and this reds first.
  it('asks the session for no rewrite, because that session has already ended', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('```leaky```');
    screenRoomReply.mockResolvedValue({
      ok: false,
      refusals: [{ ...REFUSAL, why: 'leaks a code fence' }],
    });

    await deliverLegacyAgentChatReplyOnce(makeSession());

    expect(screenRoomReply).toHaveBeenCalledTimes(1);
    expect(sendFixedReply.mock.calls).toHaveLength(1);
    expect(sendFixedReply.mock.calls[0]?.[1]).toBe('FALLBACK(Babo)');
  });
});

/**
 * Which failures earn a redispatch, and which go straight to the fallback. Their own describe
 * because the one above is at its frozen function budget.
 */
describe('deliverLegacyAgentChatReplyOnce: which failures earn a redispatch', () => {
  beforeEach(resetAgentChatMocks);

  // cm:guard the answer a room gets for a transient runner failure is the fallback and no longer a
  // second box, which is what the `cm:hack` on the bridge list prices. A row this shape cannot be
  // redispatched, because the dispatcher now addresses a venue and this row names a rid.
  it('posts the fallback for a failed/transient session rather than re-dispatching it', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);

    await deliverLegacyAgentChatReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(redispatchAgentChatSessionOnFailover).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'room-1', tmid: undefined },
      'FALLBACK(Babo)',
      FIXED_REPLY_CONSTANT,
    );
  });

  it('never retries a user_cancelled session — goes straight to fallback', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);

    await deliverLegacyAgentChatReplyOnce(
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

    await deliverLegacyAgentChatReplyOnce(
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

    await deliverLegacyAgentChatReplyOnce(
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

    await deliverLegacyAgentChatReplyOnce(makeSession({ status: 'failed', messages: [] }));

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
    screenRoomReply.mockResolvedValue({
      ok: false,
      refusals: [{ ...REFUSAL, why: 'leaks a code fence' }],
    });

    await deliverLegacyAgentChatReplyOnce(makeSession({ status: 'completed' }));

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
    screenRoomReply.mockImplementation(screenPasses);

    await deliverLegacyAgentChatReplyOnce(
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
      // cm:guard the proof NAMES the string being posted, which is the assertion ISS-978 F5 found
      // missing everywhere: `{ ok: true, problems: [] }` was satisfied by any literal and said nothing
      // about which text had been screened.
      { text: 'answer', door: 'agent-chat-completion' },
    );
  });

  it('room-never-silent: falls back when sendFixedReply throws (swallows the error)', async () => {
    claimRoomReplyDelivery.mockResolvedValue(true);
    resolveRoomPostAuth.mockResolvedValue(AUTH);
    extractFinalAssistantText.mockReturnValue('answer');
    screenRoomReply.mockImplementation(screenPasses);
    sendFixedReply.mockRejectedValue(new Error('network error'));

    await expect(deliverLegacyAgentChatReplyOnce(makeSession())).resolves.toBeUndefined();
  });
});
