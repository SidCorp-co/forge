import { beforeEach, describe, expect, it, vi } from 'vitest';

// A room answered in Agent mode, or escalated, on a project whose picked device has no runner
// bound. The people in a Rocket.Chat room hold no box and cannot bind one, and every other bot reply
// there is end-user copy in the room's language: the room is answered in that voice, naming no box,
// id or command, and the operator sentence goes to the project's admins (ISS-1236 round 2).

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

const tellAdminsDeviceUnbound = vi.fn();
vi.mock('../../devices/tell-admins-unbound.js', () => ({
  tellAdminsDeviceUnbound: (...args: unknown[]) => tellAdminsDeviceUnbound(...args),
}));

const { rocketChatTurn } = await import('./turn-inputs.js');
const { ESCALATE_TOOL_NAME } = await import('../../assistant/tools/escalate.js');

const REFUSAL =
  "Device spare-box (d-9) is not bound to project proj, so it has no checkout of it to run in. Assign the device on proj's Runners page, which binds it; to choose the folder it runs in, give the path there or, once it is assigned, run `forge-runner bind proj --path <dir>` on that device. Then try again.";

/** What a room's reader must never be shown: the box, its id, or an operator command. */
function speaksToTheRoom(text: string) {
  expect(text).toContain('Forgie');
  for (const operatorWord of ['spare-box', 'd-9', 'forge-runner', 'Runners page', '--path']) {
    expect(text).not.toContain(operatorWord);
  }
}

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
  it('answers an Agent-mode room in its own voice and tells the admins the operator sentence', async () => {
    startAgentChat.mockResolvedValue({
      started: false,
      reason: 'device-not-bound',
      refusal: REFUSAL,
      deviceId: 'd-9',
    });
    const reply = await turn().divertBeforeTurn?.({ setPhase: () => {} } as never);
    const { AGENT_CHAT_UNBOUND_REPLY } = await import('./agent-chat.js');
    expect(reply).toEqual({
      send: true,
      message: expect.objectContaining({ text: AGENT_CHAT_UNBOUND_REPLY('Forgie') }),
      screenReplaced: false,
    });
    speaksToTheRoom(AGENT_CHAT_UNBOUND_REPLY('Forgie'));
    expect(tellAdminsDeviceUnbound).toHaveBeenCalledWith({
      projectId: 'proj-1',
      deviceId: 'd-9',
      refusal: REFUSAL,
      where: 'Forgie in Rocket.Chat',
    });
    expect(startAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ project: { id: 'proj-1', slug: 'proj' } }),
    );
  });

  it("answers an escalation in the room's own voice and tells the admins the operator sentence", async () => {
    startEscalation.mockResolvedValue({
      started: false,
      reason: 'device-not-bound',
      refusal: REFUSAL,
      deviceId: 'd-9',
    });
    const reply = await turn().divertAfterTurn?.(
      { toolCalls: [{ name: ESCALATE_TOOL_NAME, arguments: '{"question":"why?"}' }] } as never,
      { setPhase: () => {}, principalUserId: 'u1' } as never,
    );
    const { ESCALATION_UNBOUND_REPLY } = await import('./escalation.js');
    expect(reply).toEqual({
      send: true,
      message: expect.objectContaining({ text: ESCALATION_UNBOUND_REPLY('Forgie') }),
      screenReplaced: true,
    });
    speaksToTheRoom(ESCALATION_UNBOUND_REPLY('Forgie'));
    expect(tellAdminsDeviceUnbound).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', deviceId: 'd-9', refusal: REFUSAL }),
    );
  });
});
