import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screenPasses } from '../../messaging/screen-passes.fixture.js';

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
/** Whether the room is still the session project's; flipped by the rebind case. */
let roomBound = true;
/** Answers of the successive `roomStillBoundTo` reads, when a case needs them to differ. */
let roomBoundSequence: boolean[] | null = null;
const roomStillBoundToCalls = vi.fn();
vi.mock('./room-delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./room-delivery.js')>()),
  roomStillBoundTo: async () => {
    const n = roomStillBoundToCalls.mock.calls.length;
    roomStillBoundToCalls();
    return roomBoundSequence
      ? (roomBoundSequence[n] ?? roomBoundSequence.at(-1) ?? true)
      : roomBound;
  },
}));

vi.mock('../store.js', () => ({
  findConnectionById: (...a: unknown[]) => findConnectionById(...a),
  decryptConnectionSecrets: (...a: unknown[]) => decryptConnectionSecrets(...a),
}));

const screenRoomReply = vi.fn();
vi.mock('../../messaging/reply-screen.js', () => ({
  screenReplyAtDoor: (...a: unknown[]) => screenRoomReply(...a),
}));

const FIXED_REPLY_CONSTANT = Symbol('fixed-reply-constant');
const sendFixedReply = vi.fn();
vi.mock('./outbound.js', () => ({
  FIXED_REPLY_CONSTANT,
  sendFixedReply: (...a: unknown[]) => sendFixedReply(...a),
}));

vi.mock('./connection-manager.js', () => ({ webBaseUrl: () => 'https://forge.example.co' }));
vi.mock('./persona.js', () => ({ rocketChatPersona: () => 'PERSONA' }));

const findConversation = vi.fn(async (..._a: unknown[]) => null as unknown);
const appendMessage = vi.fn(async (..._a: unknown[]) => ({ id: 'row-1' }));
vi.mock('../../conversations/store.js', () => ({
  findConversation: (...a: unknown[]) => findConversation(...a),
  appendMessage: (...a: unknown[]) => appendMessage(...a),
}));

const handleForProject = vi.fn(async (..._a: unknown[]) => 'handle-of-proj-1' as string | null);
vi.mock('../../conversations/participants.js', () => ({
  handleForProject: (...a: unknown[]) => handleForProject(...a),
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
    roomBound = true;
    roomBoundSequence = null;
    roomStillBoundToCalls.mockReset();
    findConversation.mockReset();
    appendMessage.mockClear();
    handleForProject.mockClear();
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
    screenRoomReply.mockImplementation(screenPasses);
  });

  const escalated = () =>
    deliverEscalationReplyOnce(
      makeSession({
        messages: [{ type: 'assistant', content: '```json\n{"answer": "raw PM answer"}\n```' }],
      }),
    );

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

  it('records it BY the project handle, resolved for the session project', async () => {
    findConversation.mockResolvedValue({ id: 'conv-9' });

    await escalated();

    expect(handleForProject).toHaveBeenCalledWith('conv-9', 'proj-1');
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ authorUserId: 'handle-of-proj-1' }),
    );
  });

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

  it('posts nothing when the room was rebound while the escalation ran', async () => {
    findConversation.mockResolvedValue({ id: 'conv-9' });
    roomBound = false;
    try {
      await escalated();
    } finally {
      roomBound = true;
    }
    expect(sendFixedReply).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    expect(updateReturning).toHaveBeenCalled();
  });

  it('posts nothing when the room was rebound during the synthesis turn', async () => {
    findConversation.mockResolvedValue({ id: 'conv-9' });
    roomBoundSequence = [true, false];

    await escalated();

    expect(runExternalChatTurn.mock.calls).toHaveLength(1);
    expect(roomStillBoundToCalls.mock.calls).toHaveLength(2);
    expect(sendFixedReply.mock.calls).toHaveLength(0);
    expect(appendMessage.mock.calls).toHaveLength(0);
  });

  it('does not record an answer the room never received', async () => {
    findConversation.mockResolvedValue({ id: 'conv-9' });
    sendFixedReply.mockRejectedValue(new Error('chat.postMessage failed'));
    await escalated();
    expect(appendMessage).not.toHaveBeenCalled();
  });
});
