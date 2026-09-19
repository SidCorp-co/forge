import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { DATABASE_URL: 'postgres://x', JWT_SECRET: 'x'.repeat(32) },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const hasInFlightRoomSession = vi.fn(async () => false);
vi.mock('./room-delivery.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  hasInFlightRoomSession: (...a: unknown[]) => hasInFlightRoomSession(...(a as [])),
}));

const startConversationAgentTurn = vi.fn(async () => ({ started: true, sessionId: 's1' }));
vi.mock('../../agent-sessions/conversation-agent.js', () => ({
  startConversationAgentTurn: (...a: unknown[]) => startConversationAgentTurn(...(a as [])),
}));

const { startAgentChat } = await import('./agent-chat.js');

const ARGS = {
  venue: {
    adapter: 'rocketchat' as const,
    externalId: 'chat.example.com room-1 thread-9',
    shape: 'direct' as const,
    projectId: 'proj-1',
  },
  conversationId: 'conv-1',
  windowId: 'win-1',
  deliveryKey: 'key-1',
  project: { id: 'proj-1', slug: 'proj', repoPath: '/repo' },
  botName: 'Babo',
  message: 'how does X work?',
  persona: 'PERSONA',
};

describe('a Rocket.Chat agent turn asked into a room that still holds an old-format one', () => {
  it('is deduped, and starts no second session', async () => {
    hasInFlightRoomSession.mockResolvedValueOnce(true);
    expect(await startAgentChat(ARGS)).toEqual({ started: false, reason: 'deduped' });
    expect(startConversationAgentTurn).not.toHaveBeenCalled();
  });

  it('asks about the room and thread the venue names, under the old marker', async () => {
    hasInFlightRoomSession.mockResolvedValueOnce(false);
    await startAgentChat(ARGS);
    expect(hasInFlightRoomSession).toHaveBeenCalledWith(
      'proj-1',
      'room-1',
      'agentChat',
      'thread-9',
    );
  });

  it('starts the turn where no old-format one is running', async () => {
    hasInFlightRoomSession.mockResolvedValueOnce(false);
    expect(await startAgentChat(ARGS)).toEqual({ started: true, sessionId: 's1' });
    expect(startConversationAgentTurn).toHaveBeenCalled();
  });
});
