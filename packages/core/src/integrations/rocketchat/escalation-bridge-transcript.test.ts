/**
 * ISS-1001 — what the ROOM keeps after an escalated answer: the answer the room
 * saw joins that room's conversation carrying the receipt the send returned,
 * and nothing joins it when the send failed or the room has no conversation.
 *
 * A sibling file rather than more cases in `escalation-bridge.test.ts`: that
 * file is at the 500-line budget, and its two describes are already the two
 * subjects the `cm:why` above its second one names.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:guard this stub stays, and stays ABOVE the subject's import: `config/env.js` validates eagerly
// at import time, so without it the whole file is a collection error rather than a failing test
vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const updateReturning = vi.fn();
const selectLimit = vi.fn();
vi.mock('../../db/client.js', () => ({
  db: {
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: updateReturning }) }) })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) })),
  },
}));

const findConnectionById = vi.fn();
const decryptConnectionSecrets = vi.fn();
vi.mock('../store.js', () => ({
  findConnectionById: (...a: unknown[]) => findConnectionById(...a),
  decryptConnectionSecrets: (...a: unknown[]) => decryptConnectionSecrets(...a),
}));

const screenStakeholderReply = vi.fn();
vi.mock('./reply-screen.js', () => ({
  screenStakeholderReply: (...a: unknown[]) => screenStakeholderReply(...a),
}));

const FIXED_REPLY_CONSTANT = Symbol('fixed-reply-constant');
const sendFixedReply = vi.fn();
vi.mock('./outbound.js', () => ({
  FIXED_REPLY_CONSTANT,
  sendFixedReply: (...a: unknown[]) => sendFixedReply(...a),
}));

vi.mock('./connection-manager.js', () => ({ webBaseUrl: 'https://forge.example.co' }));
vi.mock('./persona.js', () => ({ rocketChatPersona: () => 'PERSONA' }));

const findConversation = vi.fn(async (..._a: unknown[]) => null as unknown);
const appendMessage = vi.fn(async (..._a: unknown[]) => ({ id: 'row-1' }));
vi.mock('../../conversations/store.js', () => ({
  findConversation: (...a: unknown[]) => findConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
}));

const runExternalChatTurn = vi.fn();
vi.mock('../../assistant/external-chat.js', () => ({
  runExternalChatTurn: (...a: unknown[]) => runExternalChatTurn(...a),
}));

vi.mock('../../assistant/tools/registry.js', () => ({ buildProjectToolset: () => ({}) }));
vi.mock('../../assistant/tools/principal.js', () => ({ buildChatToolContext: () => ({}) }));

const { deliverEscalationReplyOnce } = await import('./escalation-bridge.js');

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

describe(`the room transcript after an escalated answer`, () => {
  beforeEach(() => {
    findConversation.mockReset();
    appendMessage.mockClear();
    sendFixedReply.mockReset();
    sendFixedReply.mockResolvedValue({ messageId: 'rc-msg-7' });
    updateReturning.mockReset();
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    selectLimit
      .mockReset()
      .mockResolvedValueOnce([{ slug: 'proj', name: 'Project', orgId: 'org-1' }])
      .mockResolvedValueOnce([{ createdBy: 'owner-1' }]);
    runExternalChatTurn.mockResolvedValue({
      conversationId: null,
      assistantMessageId: null,
      reply: 'the synthesized answer',
      toolCalls: [],
    });
    screenStakeholderReply.mockResolvedValue({ ok: true, problems: [] });
  });

  const escalated = () =>
    deliverEscalationReplyOnce(
      makeSession({
        messages: [{ type: 'assistant', content: '```json\n{"answer": "raw PM answer"}\n```' }],
      }),
    );

  // cm:guard the room SAW this answer, so the room's transcript holds it — with the receipt the send
  // returned, which is the same rule the fast reply path obeys and the escalated one used to skip.
  it('records the answer in the room conversation with the receipt the send returned', async () => {
    findConversation.mockResolvedValue({ id: 'conv-9' });

    await escalated();

    expect(findConversation).toHaveBeenCalledWith('rocketchat', 'chat.example.co room-1');
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-9',
        role: 'assistant',
        content: 'the synthesized answer',
        deliveryProof: { messageId: 'rc-msg-7' },
      }),
    );
  });

  // cm:guard the synthesis TURN'S OWN input is an instruction the room never saw, so it must not be
  // run against the room's conversation — only its answer goes in.
  it('runs the synthesis turn against no conversation of its own', async () => {
    findConversation.mockResolvedValue({ id: 'conv-9' });
    await escalated();
    const args = runExternalChatTurn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args.conversationId).toBeUndefined();
    expect(args.externalId).toBeUndefined();
  });

  it('invents no conversation for a room that has none', async () => {
    findConversation.mockResolvedValue(null);
    await escalated();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it('does not record an answer the room never received', async () => {
    findConversation.mockResolvedValue({ id: 'conv-9' });
    sendFixedReply.mockRejectedValue(new Error('chat.postMessage failed'));
    await escalated();
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
