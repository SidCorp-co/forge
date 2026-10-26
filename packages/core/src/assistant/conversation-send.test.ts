import { describe, expect, it, vi } from 'vitest';

// A web conversation in Agent mode on a project whose picked device has no runner bound: the
// room is told the refusal itself, not the generic "no runner" line (ISS-1236).

vi.mock('../db/client.js', () => ({ db: {} }));

const startConversationAgentTurn = vi.fn();
vi.mock('../agent-sessions/conversation-agent.js', () => ({
  startConversationAgentTurn: (...args: unknown[]) => startConversationAgentTurn(...args),
}));

const { webConversationTurn } = await import('./conversation-send.js');

const REFUSAL =
  'Device spare-box (d-9) is not bound to project proj, so it has no checkout of it to run in.';

describe('webConversationTurn — a device the project never bound', () => {
  it('answers an Agent-mode room with the refusal sentence, handing the lane no project path', async () => {
    startConversationAgentTurn.mockResolvedValue({
      started: false,
      reason: 'device-not-bound',
      refusal: REFUSAL,
    });
    const turn = webConversationTurn({
      project: { id: 'proj-1', slug: 'proj', name: 'Proj' },
      handleName: 'Forgie',
      askedBy: 'Ann',
      window: {
        venue: { projectId: 'proj-1' } as never,
        conversationId: 'conv-1',
        windowId: 'w1',
        deliveryKey: 'k1',
        mode: 'agent',
        question: 'why?',
        images: [],
        conversationContext: async () => null,
        reserve: async () => true,
      },
      progress: {} as never,
      externalStop: new AbortController().signal,
    });

    const reply = await turn.divertBeforeTurn?.({ setPhase: () => {} } as never);

    expect(reply).toEqual({
      send: true,
      message: expect.objectContaining({ text: REFUSAL }),
      screenReplaced: false,
    });
    expect(startConversationAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ project: { id: 'proj-1', slug: 'proj' } }),
    );
  });
});
