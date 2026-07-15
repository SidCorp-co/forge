import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the ISS-675 completion bridge: final-assistant-text
// extraction (both on-disk message shapes), the CAS idempotency stamp (safe to
// call from both session-terminal writers), and the guard-fail → fallback
// branch.

// Stub eager env validation (config/env.js throws at import when DATABASE_URL /
// JWT_SECRET / DEVICE_TOKEN_PEPPER are absent) — escalation-bridge.js pulls in
// escalation.js's chat-turn/lifecycle graph transitively. Same pattern as
// agent-sessions/chat-turn.test.ts.
vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const updateReturning = vi.fn();
const updateWhere = vi.fn(() => ({ returning: updateReturning }));
const updateSet = vi.fn(() => ({ where: updateWhere }));
vi.mock('../../db/client.js', () => ({
  db: { update: vi.fn(() => ({ set: updateSet })) },
}));

const findConnectionById = vi.fn();
const decryptConnectionSecrets = vi.fn();
vi.mock('../store.js', () => ({
  findConnectionById: (...args: unknown[]) => findConnectionById(...args),
  decryptConnectionSecrets: (...args: unknown[]) => decryptConnectionSecrets(...args),
}));

const screenStakeholderReply = vi.fn();
vi.mock('./reply-screen.js', () => ({
  screenStakeholderReply: (...args: unknown[]) => screenStakeholderReply(...args),
}));

const postRoomMessage = vi.fn();
vi.mock('./rest-client.js', () => ({
  postRoomMessage: (...args: unknown[]) => postRoomMessage(...args),
}));

const { deliverEscalationReplyOnce, extractFinalAssistantText } = await import(
  './escalation-bridge.js'
);

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    projectId: 'proj-1',
    status: 'completed',
    messages: [],
    metadata: {
      escalation: {
        connectionId: 'conn-1',
        rid: 'room-1',
        tmid: null,
        botName: 'Babo',
        askedByUsername: 'alice',
        deliveredAt: null,
      },
    },
    ...overrides,
  } as never;
}

describe('extractFinalAssistantText', () => {
  it('reads the desktop/chat shape (entry.role)', () => {
    const text = extractFinalAssistantText([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'the answer' },
    ]);
    expect(text).toBe('the answer');
  });

  it('reads the CLI-runner shape (entry.type, no role)', () => {
    const text = extractFinalAssistantText([
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'the answer' },
    ]);
    expect(text).toBe('the answer');
  });

  it('skips trailing empty-content entries to find the last real answer', () => {
    const text = extractFinalAssistantText([
      { type: 'assistant', content: 'the real answer' },
      { type: 'assistant', content: '' },
    ]);
    expect(text).toBe('the real answer');
  });

  it('returns null when there is no assistant text at all', () => {
    expect(extractFinalAssistantText([{ type: 'user', content: 'hi' }])).toBeNull();
    expect(extractFinalAssistantText(null)).toBeNull();
  });
});

describe('deliverEscalationReplyOnce', () => {
  beforeEach(() => {
    updateReturning.mockReset();
    findConnectionById.mockReset();
    decryptConnectionSecrets.mockReset();
    screenStakeholderReply.mockReset();
    postRoomMessage.mockReset();
  });

  it('is a no-op for a session with no escalation metadata', async () => {
    await deliverEscalationReplyOnce(makeSession({ metadata: {} }));
    expect(updateReturning).not.toHaveBeenCalled();
  });

  it('is a no-op when already delivered (deliveredAt already set)', async () => {
    await deliverEscalationReplyOnce(
      makeSession({
        metadata: {
          escalation: {
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
    await deliverEscalationReplyOnce(makeSession());
    expect(postRoomMessage).not.toHaveBeenCalled();
  });

  it('posts the screened final answer on a completed session that passes the guards', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverEscalationReplyOnce(
      makeSession({
        messages: [{ type: 'assistant', content: 'Đây là câu trả lời.' }], // i18n-allow: a plain-language final escalation answer
      }),
    );

    expect(postRoomMessage).toHaveBeenCalledWith(
      { serverUrl: 'https://chat.example.co', authToken: 'tok', userId: 'bot-1' },
      'room-1',
      'Đây là câu trả lời.', // i18n-allow: a plain-language final escalation answer
      undefined,
    );
  });

  it('falls back to the honest fallback reply when the guard rejects the answer', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    screenStakeholderReply.mockResolvedValue({ ok: false, problems: ['leaks a code fence'] });

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '```leaky```' }] }),
    );

    const [, , postedText] = postRoomMessage.mock.calls[0] as [unknown, unknown, string, unknown];
    expect(postedText).not.toContain('```');
    expect(postedText).toMatch(/Babo/);
  });

  it('falls back to the honest fallback reply on a failed/empty session without calling the guard', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });

    await deliverEscalationReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(screenStakeholderReply).not.toHaveBeenCalled();
    expect(postRoomMessage).toHaveBeenCalled();
  });
});
