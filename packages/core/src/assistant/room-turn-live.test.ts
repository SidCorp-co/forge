// @direct-test-of packages/core/src/agent-sessions/room-live.ts
// @direct-test-of packages/core/src/agent-sessions/broadcast.ts
import type { AgentSessionLiveItem } from '@forge/contracts/agent-session-live';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const published: Array<{ room: string; event: string; data: { items: AgentSessionLiveItem[] } }> =
  [];
const readers = new Set<string>();

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../lib/rooms.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rooms.js')>();
  return {
    ...real,
    roomManager: {
      publish: (room: string, msg: { event: string; data: { items: AgentSessionLiveItem[] } }) => {
        published.push({ room, event: msg.event, data: msg.data });
        return 1;
      },
    },
  };
});
vi.mock('../conversations/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../conversations/index.js')>();
  return {
    ...real,
    listParticipants: vi.fn(async () =>
      ['u-asker', 'u-second', 'u-gone'].map((userId) => ({ kind: 'person', userId })),
    ),
    // the check the room's delivery takes: a reader who may no longer read it is sent nothing
    assertConversationReadable: vi.fn(async (_id: string, userId: string) => {
      if (!readers.has(userId)) throw new Error('not a reader');
      return [];
    }),
  };
});

const { publishEphemeralFrame } = await import('../ws/box-delivery.js');
const { provideEphemeralPublisher } = await import('../lib/ephemeral.js');
const { broadcastLive } = await import('../agent-sessions/broadcast.js');
const { registerRoomTurnLive } = await import('./conversation-adapter.js');

const turn = {
  id: 's-turn',
  projectId: 'p-1',
  deviceId: 'd-1',
  status: 'running',
  kind: 'chat' as const,
  userId: 'u-asker',
  metadata: {
    unattended: true,
    conversationAgent: { conversationId: 'c-1', asker: { userId: 'u-asker' } },
  },
};

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const to = (userId: string) =>
  published.filter((p) => p.room === `user:${userId}` && p.event === 'agent-session.live');

describe('ISS-1268: every reader of a room sees its Agent turn progress', () => {
  beforeEach(() => {
    published.length = 0;
    readers.clear();
    for (const u of ['u-asker', 'u-second']) readers.add(u);
    provideEphemeralPublisher(publishEphemeralFrame);
    registerRoomTurnLive();
  });

  it("a second member receives the turn's live frames, without its words", async () => {
    broadcastLive(turn, 'c-1', [
      { kind: 'message', id: 'msg_1', parent: null },
      { kind: 'text', text: 'the unscreened draft', parent: null },
      { kind: 'retry', attempt: 2, maxRetries: 10, delayMs: 4000, errorStatus: 529 },
    ]);
    await settle();

    expect(to('u-asker')).toHaveLength(1);
    expect(to('u-asker')[0]?.data.items.map((i) => i.kind)).toEqual(['message', 'text', 'retry']);

    expect(to('u-second')).toHaveLength(1);
    expect(to('u-second')[0]?.data.items.map((i) => i.kind)).toEqual(['message', 'retry']);
    expect(JSON.stringify(to('u-second'))).not.toContain('unscreened draft');
    expect(to('u-gone')).toEqual([]);
  });

  it('the end of the turn reaches the second member, so the room reads its state again', async () => {
    broadcastLive(turn, 'c-1', [{ kind: 'ended', reason: 'completed' }]);
    await settle();
    expect(to('u-second')[0]?.data.items).toEqual([{ kind: 'ended', reason: 'completed' }]);
  });

  it('a batch of words alone, and its thinking and suggestion, reach no other member', async () => {
    broadcastLive(turn, 'c-1', [
      { kind: 'thinking', text: 'hmm', parent: null },
      { kind: 'text', text: 'Hello', parent: null },
      { kind: 'suggestion', text: 'next prompt' },
    ]);
    await settle();
    expect(to('u-asker')).toHaveLength(1);
    expect(to('u-second')).toEqual([]);
  });
});
