import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit tests for the ISS-675/ISS-687 completion bridge: final-assistant-text
// extraction (both on-disk message shapes), the CAS idempotency stamp (safe to
// call from both session-terminal writers), the PM structured-payload parser,
// and the Bao-synthesis delivery path (the bridge no longer posts the PM's
// raw text — it relays a fresh Bao turn's reply instead).

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
const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
vi.mock('../../db/client.js', () => ({
  db: {
    update: vi.fn(() => ({ set: updateSet })),
    select: vi.fn(() => ({ from: selectFrom })),
  },
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

const rocketChatPersona = vi.fn(() => 'PERSONA');
vi.mock('./connection-manager.js', () => ({
  rocketChatPersona: (...args: unknown[]) => rocketChatPersona(...args),
  webBaseUrl: 'https://forge.example.co',
}));

const runExternalChatTurn = vi.fn();
vi.mock('../../chat/external-chat.js', () => ({
  runExternalChatTurn: (...args: unknown[]) => runExternalChatTurn(...args),
}));

const buildProjectToolset = vi.fn(() => ({ TOOLSET: true }));
vi.mock('../../chat/tools/registry.js', () => ({
  buildProjectToolset: (...args: unknown[]) => buildProjectToolset(...args),
}));

const buildChatToolContext = vi.fn(() => ({ CTX: true }));
vi.mock('../../chat/tools/principal.js', () => ({
  buildChatToolContext: (...args: unknown[]) => buildChatToolContext(...args),
}));

const { deliverEscalationReplyOnce, extractFinalAssistantText, parseEscalationPayload } =
  await import('./escalation-bridge.js');

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
        question: 'How does X work?',
        deliveredAt: null,
      },
    },
    ...overrides,
  } as never;
}

/** Queue the two sequential `db.select` calls `resolveEscalationRoute` makes
 *  (projects then organizations). */
function mockRouteResolution(proj = { slug: 'proj', name: 'Project', orgId: 'org-1' }) {
  selectLimit.mockResolvedValueOnce([proj]).mockResolvedValueOnce([{ createdBy: 'owner-1' }]);
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

describe('parseEscalationPayload', () => {
  it('parses a valid fenced JSON payload (answer only)', () => {
    const text = 'thinking...\n```json\n{"answer": "It works like this."}\n```';
    expect(parseEscalationPayload(text)).toEqual({ answer: 'It works like this.' });
  });

  it('parses a valid payload carrying an issueProposal', () => {
    const text =
      '```json\n{"answer": "Known gap.", "issueProposal": {"title": "T", "description": "D", "reason": "R"}}\n```';
    expect(parseEscalationPayload(text)).toEqual({
      answer: 'Known gap.',
      issueProposal: { title: 'T', description: 'D', reason: 'R' },
    });
  });

  it('takes the LAST fenced block when several appear', () => {
    const text =
      '```json\n{"answer": "draft one"}\n```\nrevised:\n```json\n{"answer": "final"}\n```';
    expect(parseEscalationPayload(text)).toEqual({ answer: 'final' });
  });

  it('falls back to the raw text when there is no fenced JSON block', () => {
    const text = 'Plain-language answer with no fence.';
    expect(parseEscalationPayload(text)).toEqual({ answer: text });
  });

  it('falls back to the raw text on malformed JSON inside the fence', () => {
    const text = '```json\n{ not valid json\n```';
    expect(parseEscalationPayload(text)).toEqual({ answer: text });
  });

  it('drops an incomplete issueProposal but keeps the answer', () => {
    const text = '```json\n{"answer": "ok", "issueProposal": {"title": "T"}}\n```';
    expect(parseEscalationPayload(text)).toEqual({ answer: 'ok' });
  });
});

describe('deliverEscalationReplyOnce', () => {
  beforeEach(() => {
    updateReturning.mockReset();
    selectLimit.mockReset();
    findConnectionById.mockReset();
    decryptConnectionSecrets.mockReset();
    screenStakeholderReply.mockReset();
    postRoomMessage.mockReset();
    rocketChatPersona.mockClear();
    runExternalChatTurn.mockReset();
    buildProjectToolset.mockClear();
    buildChatToolContext.mockClear();
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

  it('delivers via a Bao synthesis turn — the room never receives the raw PM text', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'bao-session',
      reply: 'Bao says: here is the synthesized answer.',
      toolCalls: [],
    });
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverEscalationReplyOnce(
      makeSession({
        messages: [{ type: 'assistant', content: '```json\n{"answer": "raw PM answer"}\n```' }],
      }),
    );

    expect(runExternalChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        source: 'rocketchat',
        message: expect.stringContaining('raw PM answer'),
        tools: undefined,
        persona: 'PERSONA',
      }),
    );
    expect(postRoomMessage).toHaveBeenCalledWith(
      { serverUrl: 'https://chat.example.co', authToken: 'tok', userId: 'bot-1' },
      'room-1',
      'Bao says: here is the synthesized answer.',
      undefined,
    );
    // never posts the PM's raw answer text directly
    expect(postRoomMessage.mock.calls[0]?.[2]).not.toContain('raw PM answer');
  });

  it('PM-advise → Bao-create: builds the forge toolset only when an issueProposal is present', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'bao-session',
      reply: 'Logged it as a draft issue.',
      toolCalls: [{ name: 'forge_issues', arguments: '{"action":"create"}' }],
    });
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverEscalationReplyOnce(
      makeSession({
        messages: [
          {
            type: 'assistant',
            content:
              '```json\n{"answer": "found a gap", "issueProposal": {"title": "T", "description": "D", "reason": "R"}}\n```',
          },
        ],
      }),
    );

    expect(buildChatToolContext).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-1', projectId: 'proj-1', projectSlug: 'proj' }),
    );
    expect(buildProjectToolset).toHaveBeenCalled();
    expect(runExternalChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ tools: { TOOLSET: true } }),
    );
  });

  it('no issueProposal → the synthesis turn runs tool-less', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'bao-session',
      reply: 'Just an answer.',
      toolCalls: [],
    });
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });

    await deliverEscalationReplyOnce(
      makeSession({
        messages: [{ type: 'assistant', content: '```json\n{"answer": "just an answer"}\n```' }],
      }),
    );

    expect(buildProjectToolset).not.toHaveBeenCalled();
    expect(runExternalChatTurn).toHaveBeenCalledWith(expect.objectContaining({ tools: undefined }));
  });

  it('falls back to the honest fallback reply when the guard rejects the synthesized answer', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'bao-session',
      reply: '```leaky```',
      toolCalls: [],
    });
    screenStakeholderReply.mockResolvedValue({ ok: false, problems: ['leaks a code fence'] });

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '```json\n{"answer": "x"}\n```' }] }),
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

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(screenStakeholderReply).not.toHaveBeenCalled();
    expect(postRoomMessage).toHaveBeenCalled();
  });

  it('room-never-silent: falls back when the Bao synthesis turn throws', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn.mockRejectedValue(new Error('provider timeout'));

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '```json\n{"answer": "x"}\n```' }] }),
    );

    expect(postRoomMessage).toHaveBeenCalled();
    const [, , postedText] = postRoomMessage.mock.calls[0] as [unknown, unknown, string, unknown];
    expect(postedText).toMatch(/Babo/);
  });

  it('room-never-silent: falls back when the project/org route cannot be resolved', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    selectLimit.mockResolvedValueOnce([]); // no project row found

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '```json\n{"answer": "x"}\n```' }] }),
    );

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(postRoomMessage).toHaveBeenCalled();
    const [, , postedText] = postRoomMessage.mock.calls[0] as [unknown, unknown, string, unknown];
    expect(postedText).toMatch(/Babo/);
  });
});
