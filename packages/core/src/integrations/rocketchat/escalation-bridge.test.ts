/**
 * The ISS-675/ISS-687 completion bridge: the CAS idempotency stamp (safe to
 * call from both session-terminal writers), the PM structured-payload parser,
 * and the Bao-synthesis delivery path (the bridge no longer posts the PM's raw
 * text — it relays a fresh Bao turn's reply instead). Final-assistant-text
 * extraction moved to `room-delivery.test.ts` with the function itself.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./room-delivery.js', async (o) => ({
  ...(await o<typeof import('./room-delivery.js')>()),
  roomStillBoundTo: async () => true,
}));
vi.mock('../store.js', () => ({
  findConnectionById: (...args: unknown[]) => findConnectionById(...args),
  decryptConnectionSecrets: (...args: unknown[]) => decryptConnectionSecrets(...args),
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

const rocketChatPersona = vi.fn((..._args: unknown[]) => 'PERSONA');
vi.mock('./connection-manager.js', () => ({
  webBaseUrl: 'https://forge.example.co',
}));
vi.mock('../../conversations/store.js', () => ({
  findConversation: async () => null,
  appendMessage: async () => ({ id: 'row-1' }),
}));

vi.mock('./persona.js', () => ({
  rocketChatPersona: (...args: unknown[]) => rocketChatPersona(...args),
}));

const runExternalChatTurn = vi.fn();
vi.mock('../../assistant/external-chat.js', () => ({
  runExternalChatTurn: (...args: unknown[]) => runExternalChatTurn(...args),
}));

const buildProjectToolset = vi.fn((..._args: unknown[]) => ({ TOOLSET: true }));
vi.mock('../../assistant/tools/registry.js', () => ({
  buildProjectToolset: (...args: unknown[]) => buildProjectToolset(...args),
}));

const buildChatToolContext = vi.fn((..._args: unknown[]) => ({ CTX: true }));
vi.mock('../../assistant/tools/principal.js', () => ({
  buildChatToolContext: (...args: unknown[]) => buildChatToolContext(...args),
}));

const { deliverEscalationReplyOnce, parseEscalationPayload } = await import(
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

const REFUSAL = {
  rule: 'no-developer-detail',
  why: 'leaks a code fence',
  quote: null,
  shape: 'plain language',
  example: 'The fix is in.',
} as const;

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

function resetEscalationMocks(): void {
  updateReturning.mockReset();
  selectLimit.mockReset();
  findConnectionById.mockReset();
  decryptConnectionSecrets.mockReset();
  screenRoomReply.mockReset();
  sendFixedReply.mockReset();
  rocketChatPersona.mockClear();
  runExternalChatTurn.mockReset();
  buildProjectToolset.mockClear();
  buildChatToolContext.mockClear();
}

describe('deliverEscalationReplyOnce', () => {
  beforeEach(resetEscalationMocks);

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
    updateReturning.mockResolvedValue([]);
    await deliverEscalationReplyOnce(makeSession());
    expect(sendFixedReply).not.toHaveBeenCalled();
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
    screenRoomReply.mockResolvedValue({ ok: true });

    await deliverEscalationReplyOnce(
      makeSession({
        messages: [{ type: 'assistant', content: '```json\n{"answer": "raw PM answer"}\n```' }],
      }),
    );

    expect(runExternalChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        adapter: 'rocketchat',
        message: expect.stringContaining('raw PM answer'),
        tools: undefined,
        persona: 'PERSONA',
      }),
    );
    expect(sendFixedReply).toHaveBeenCalledWith(
      {
        kind: 'rest',
        auth: { serverUrl: 'https://chat.example.co', authToken: 'tok', userId: 'bot-1' },
        rid: 'room-1',
        tmid: undefined,
      },
      'Bao says: here is the synthesized answer.',
      { ok: true, problems: [] },
    );
    expect(sendFixedReply.mock.calls[0]?.[1]).not.toContain('raw PM answer');
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
    screenRoomReply.mockResolvedValue({ ok: true });

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
      expect.objectContaining({ tools: { TOOLSET: true }, turnKind: 'agentic' }),
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
    screenRoomReply.mockResolvedValue({ ok: true });

    await deliverEscalationReplyOnce(
      makeSession({
        messages: [{ type: 'assistant', content: '```json\n{"answer": "just an answer"}\n```' }],
      }),
    );

    expect(buildProjectToolset).not.toHaveBeenCalled();
    expect(runExternalChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ tools: undefined, turnKind: 'relay' }),
    );
  });
});

describe('the repair budget the escalation-synthesis door declares', () => {
  it('repairs a synthesis that failed the screen, and shows the room the repair', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn
      .mockResolvedValueOnce({ sessionId: 'bao', reply: 'first, refused', toolCalls: [] })
      .mockResolvedValueOnce({ sessionId: 'bao', reply: 'the repaired answer', toolCalls: [] });
    screenRoomReply
      .mockResolvedValueOnce({ ok: false, refusals: [REFUSAL] })
      .mockResolvedValueOnce({ ok: true });

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '{"answer": "raw"}' }] }),
    );

    expect(runExternalChatTurn).toHaveBeenCalledTimes(2);
    expect(runExternalChatTurn.mock.calls[1]?.[0]).toMatchObject({
      message: expect.stringContaining('leaks a code fence'),
    });
    expect(sendFixedReply.mock.calls).toHaveLength(1);
    expect(sendFixedReply.mock.calls[0]?.[1]).toBe('the repaired answer');
  });

  it('spends exactly one repair and then posts one fixed fallback', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'bao',
      reply: 'still wrong',
      toolCalls: [],
    });
    screenRoomReply.mockResolvedValue({ ok: false, refusals: [REFUSAL] });

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '{"answer": "raw"}' }] }),
    );

    expect(runExternalChatTurn).toHaveBeenCalledTimes(2);
    expect(sendFixedReply.mock.calls).toHaveLength(1);
    expect(sendFixedReply.mock.calls[0]?.[1]).not.toBe('still wrong');
  });
});

describe('deliverEscalationReplyOnce: the room is never left silent', () => {
  beforeEach(resetEscalationMocks);

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
    screenRoomReply.mockResolvedValue({
      ok: false,
      refusals: [{ ...REFUSAL, why: 'leaks a code fence' }],
    });

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '```json\n{"answer": "x"}\n```' }] }),
    );

    const [, postedText] = sendFixedReply.mock.calls[0] as [unknown, string];
    expect(postedText).not.toContain('```');
    expect(postedText).toMatch(/Babo/);
  });

  it('falls back to the honest fallback reply on a failed/empty session without calling the guard', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });

    await deliverEscalationReplyOnce(makeSession({ status: 'failed', messages: [] }));

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(screenRoomReply).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalled();
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

    expect(sendFixedReply).toHaveBeenCalled();
    const [, postedText] = sendFixedReply.mock.calls[0] as [unknown, string];
    expect(postedText).toMatch(/Babo/);
  });

  it('room-never-silent: falls back when the project/org route cannot be resolved', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    selectLimit.mockResolvedValueOnce([]);

    await deliverEscalationReplyOnce(
      makeSession({ messages: [{ type: 'assistant', content: '```json\n{"answer": "x"}\n```' }] }),
    );

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(sendFixedReply).toHaveBeenCalled();
    const [, postedText] = sendFixedReply.mock.calls[0] as [unknown, string];
    expect(postedText).toMatch(/Babo/);
  });
});
