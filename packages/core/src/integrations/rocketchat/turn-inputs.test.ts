import { beforeEach, describe, expect, it, vi } from 'vitest';

// A room answered in Agent mode, or escalated, on a project whose picked device has no runner
// bound: the room is told the refusal itself, not the generic "no runner" line (ISS-1236).

const selectLimit = vi.fn();
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimit })) })),
    })),
  },
}));
vi.mock('./context.js', () => ({ buildConversationContext: vi.fn(async () => null) }));

const startAgentChat = vi.fn();
vi.mock('./agent-chat.js', async (orig) => ({
  ...(await orig<typeof import('./agent-chat.js')>()),
  startAgentChat: (...args: unknown[]) => startAgentChat(...args),
}));
const startEscalation = vi.fn();
vi.mock('./escalation.js', async (orig) => ({
  ...(await orig<typeof import('./escalation.js')>()),
  startEscalation: (...args: unknown[]) => startEscalation(...args),
}));

const { rocketChatTurn } = await import('./turn-inputs.js');
const { ESCALATE_TOOL_NAME } = await import('../../assistant/tools/escalate.js');

const REFUSAL =
  'Device spare-box (d-9) is not bound to project proj, so it has no checkout of it to run in.';

function turn() {
  return rocketChatTurn({
    bot: { botName: 'Forgie', serverUrl: 'https://chat.example', authToken: 't', botUserId: 'b' },
    route: {
      rid: 'r1',
      projectId: 'proj-1',
      projectSlug: 'proj',
      projectName: 'Proj',
      principalUserId: 'u1',
    },
    subject: {
      rid: 'r1',
      tmid: undefined,
      text: 'why?',
      username: 'ann',
      messageIds: ['m1'],
      images: [],
    },
    connectionId: 'c1',
    shape: 'group',
    webBaseUrl: undefined,
    cut: { reason: 'quiet', coveredSeq: [1, 1], snapshotAt: new Date() } as never,
    window: {
      venue: { projectId: 'proj-1' } as never,
      conversationId: 'conv-1',
      windowId: 'w1',
      deliveryKey: 'k1',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectLimit.mockResolvedValue([{ agentConfig: { rocketChatAnswerMode: 'agent' } }]);
});

describe('rocketChatTurn — a device the project never bound', () => {
  it('answers an Agent-mode room with the refusal sentence', async () => {
    startAgentChat.mockResolvedValue({
      started: false,
      reason: 'device-not-bound',
      refusal: REFUSAL,
    });
    const reply = await turn().divertBeforeTurn?.({ setPhase: () => {} } as never);
    expect(reply).toEqual({
      send: true,
      message: expect.objectContaining({ text: REFUSAL }),
      screenReplaced: false,
    });
    expect(startAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ project: { id: 'proj-1', slug: 'proj' } }),
    );
  });

  it('answers an escalation with the refusal sentence', async () => {
    startEscalation.mockResolvedValue({
      started: false,
      reason: 'device-not-bound',
      refusal: REFUSAL,
    });
    const reply = await turn().divertAfterTurn?.(
      { toolCalls: [{ name: ESCALATE_TOOL_NAME, arguments: '{"question":"why?"}' }] } as never,
      { setPhase: () => {}, principalUserId: 'u1' } as never,
    );
    expect(reply).toEqual({
      send: true,
      message: expect.objectContaining({ text: REFUSAL }),
      screenReplaced: true,
    });
  });
});
