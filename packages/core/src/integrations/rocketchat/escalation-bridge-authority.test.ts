/**
 * ISS-987 — whose authority an escalated turn runs under, split out of
 * `escalation-bridge.test.ts` when that file reached its size budget. Its own
 * `cm:why` already named these the separate subject they are.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// cm:guard this stub must stay, and must stay above the subject's import — `config/env.js` validates EAGERLY and throws at import time without DATABASE_URL / JWT_SECRET / DEVICE_TOKEN_PEPPER, which `escalation-bridge.js` pulls in transitively through escalation.js's chat-turn/lifecycle graph, so removing it turns the whole file into a collection error rather than a failing test (same pattern as agent-sessions/chat-turn.test.ts)
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
// cm:why the room-is-still-ours lookup is stubbed true here: this file's fake db answers only the subject's own queries, and that check has its own cases in room-delivery.test.ts and its refusal case in escalation-bridge-transcript.test.ts.
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
  webBaseUrl: () => 'https://forge.example.co',
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

/** Queue the two sequential `db.select` calls `resolveEscalationRoute` makes
 *  (projects then organizations). */
function mockRouteResolution(proj = { slug: 'proj', name: 'Project', orgId: 'org-1' }) {
  selectLimit.mockResolvedValueOnce([proj]).mockResolvedValueOnce([{ createdBy: 'owner-1' }]);
}

describe('deliverEscalationReplyOnce turn authority', () => {
  beforeEach(() => {
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
  });

  it('runs a direct-room synthesis as the speaker the escalation stored', async () => {
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
        metadata: {
          escalation: {
            connectionId: 'conn-1',
            rid: 'room-1',
            tmid: null,
            botName: 'Babo',
            askedByUsername: 'alice',
            question: 'How does X work?',
            shape: 'direct',
            principalUserId: 'speaker-user-9',
            deliveredAt: null,
          },
        },
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
      expect.objectContaining({ userId: 'speaker-user-9' }),
    );
  });

  it('runs no synthesis turn for a direct-room escalation that stored no speaker', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();

    await deliverEscalationReplyOnce(
      makeSession({
        metadata: {
          escalation: {
            connectionId: 'conn-1',
            rid: 'room-1',
            tmid: null,
            botName: 'Babo',
            askedByUsername: 'alice',
            question: 'How does X work?',
            shape: 'direct',
            deliveredAt: null,
          },
        },
        messages: [{ type: 'assistant', content: '```json\n{"answer": "found a gap"}\n```' }],
      }),
    );

    expect(runExternalChatTurn).not.toHaveBeenCalled();
    expect(buildChatToolContext).not.toHaveBeenCalled();
  });

  it('posts the fixed fallback for a direct-room escalation that stored no speaker', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();

    await deliverEscalationReplyOnce(
      makeSession({
        metadata: {
          escalation: {
            connectionId: 'conn-1',
            rid: 'room-1',
            tmid: null,
            botName: 'Babo',
            askedByUsername: 'alice',
            question: 'How does X work?',
            shape: 'direct',
            deliveredAt: null,
          },
        },
        messages: [{ type: 'assistant', content: '```json\n{"answer": "found a gap"}\n```' }],
      }),
    );

    expect(sendFixedReply).toHaveBeenCalled();
  });

  it('leaves a group-room escalation on the organization creator', async () => {
    updateReturning.mockResolvedValue([{ id: 'session-1' }]);
    findConnectionById.mockResolvedValue({ config: { serverUrl: 'https://chat.example.co' } });
    decryptConnectionSecrets.mockReturnValue({ authToken: 'tok', userId: 'bot-1' });
    mockRouteResolution();
    runExternalChatTurn.mockResolvedValue({
      sessionId: 'bao-session',
      reply: 'Logged it.',
      toolCalls: [{ name: 'forge_issues', arguments: '{"action":"create"}' }],
    });
    screenRoomReply.mockResolvedValue({ ok: true });

    await deliverEscalationReplyOnce(
      makeSession({
        metadata: {
          escalation: {
            connectionId: 'conn-1',
            rid: 'room-1',
            tmid: null,
            botName: 'Babo',
            askedByUsername: 'alice',
            question: 'How does X work?',
            shape: 'group',
            deliveredAt: null,
          },
        },
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
      expect.objectContaining({ userId: 'owner-1' }),
    );
  });
});
