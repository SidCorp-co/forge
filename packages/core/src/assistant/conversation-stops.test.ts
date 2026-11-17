// @direct-test-of packages/core/src/agent-sessions/interrupt-turn.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ deviceId: string; event: string; data: unknown }> = [];
let listening = true;
const turns: Array<{ sessionId: string; state: string }> = [];
const sessions = new Map<string, { id: string; status: string; deviceId: string | null }>();

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../agent-sessions/ports.js', () => ({
  agentSessionsPorts: () => ({
    sendToBoxNow: (deviceId: string, envelope: { event: string; data: unknown }) => {
      if (!listening) return 0;
      sent.push({ deviceId, ...envelope });
      return 1;
    },
  }),
}));
vi.mock('../agent-sessions/index.js', async () => ({
  interruptRunningTurn: (await import('../agent-sessions/interrupt-turn.js')).interruptRunningTurn,
  sessionRowById: async (id: string) => {
    const row = sessions.get(id);
    return row ? { ...row, metadata: null } : null;
  },
}));
vi.mock('../conversations/index.js', async () => {
  const { refuseConversation } = await import('../conversations/refusals.js');
  return {
    refuseConversation,
    readConversationAgentTurns: async () => turns,
    listWindowsForConversation: async () => [],
  };
});

const { stopConversationTurns, registerTurnStop, STOPPED_BY_A_PERSON } = await import(
  './conversation-stops.js'
);

describe("ISS-1268: a room's Stop ends the turn it runs", () => {
  beforeEach(() => {
    sent.length = 0;
    turns.length = 0;
    sessions.clear();
    listening = true;
  });

  it('a room Stop interrupts the Agent turn its box runs, as a session Stop does', async () => {
    turns.push({ sessionId: 's-turn', state: 'running' });
    sessions.set('s-turn', { id: 's-turn', status: 'running', deviceId: 'd-box' });
    await expect(stopConversationTurns('c-1')).resolves.toBe(1);
    expect(sent).toEqual([
      { deviceId: 'd-box', event: 'agent:interrupt', data: { sessionId: 's-turn' } },
    ]);
  });

  it('a turn whose box is gone is refused by name, never answered as stopped', async () => {
    turns.push({ sessionId: 's-turn', state: 'running' });
    sessions.set('s-turn', { id: 's-turn', status: 'running', deviceId: 'd-box' });
    listening = false;
    await expect(stopConversationTurns('c-1')).rejects.toMatchObject({
      refusals: [{ code: 'NO_LIVE_SESSION' }],
    });
  });

  it('a turn this core runs is aborted here, and the box is told nothing', async () => {
    const handle = registerTurnStop('c-1');
    await expect(stopConversationTurns('c-1')).resolves.toBe(1);
    expect(handle.signal.reason).toBe(STOPPED_BY_A_PERSON);
    expect(sent).toEqual([]);
    handle.release();
  });

  it('a room running nothing is refused by name', async () => {
    turns.push({ sessionId: 's-old', state: 'delivered' });
    await expect(stopConversationTurns('c-1')).rejects.toMatchObject({
      refusals: [{ code: 'CONVERSATION_NOTHING_RUNNING' }],
    });
  });
});
