import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (payload: unknown) => unknown>();
const emitted: Array<{ type: string; payload: unknown }> = [];
const published: Array<{ room: string; event: string }> = [];
const admins = new Map<string, string[]>();

vi.mock('../outbox/index.js', () => ({
  consume: (type: string, consumer: { handle: (payload: unknown) => unknown }) => {
    handlers.set(type, consumer.handle);
  },
  emitEvent: vi.fn(async (_tx: unknown, type: string, payload: unknown) => {
    emitted.push({ type, payload });
  }),
}));
vi.mock('../lib/rooms.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/rooms.js')>();
  return {
    ...real,
    roomManager: {
      publish: (room: string, msg: { event: string }) => {
        published.push({ room, event: msg.event });
        return 1;
      },
    },
  };
});
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../pipeline/index.js', () => ({
  emitPipelineWedge: vi.fn(),
  resolvePipelineWedge: vi.fn(),
}));
vi.mock('../permissions/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../permissions/index.js')>();
  return {
    ...real,
    holdersOf: vi.fn(async (_permission: string, projectIds: readonly string[]) => {
      return new Map(projectIds.map((id) => [id, admins.get(id) ?? []]));
    }),
  };
});

const { registerWsBroadcastSubscribers } = await import('../ws/broadcast-subscribers.js');
const { publishEphemeralFrame } = await import('../ws/box-delivery.js');
const { provideEphemeralPublisher } = await import('../lib/ephemeral.js');
const { broadcastSession, broadcastTurnAppended, broadcastTurnTruncated } = await import(
  './broadcast.js'
);
const { assertAgentChatOwner } = await import('./session-access.js');

const OWNER = 'u-owner';
const MEMBER = 'u-member';
const ADMIN = 'u-admin';

/** A chat a person opened through the session doors: kind chat, not unattended. */
const personChat = {
  id: 's-chat',
  projectId: 'p-1',
  deviceId: 'd-1',
  status: 'running',
  kind: 'chat' as const,
  userId: OWNER,
  metadata: null,
};

/** Every outbox event written so far handed to its consumer, after pending audience reads settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const e of emitted.splice(0)) await handlers.get(e.type)?.(e.payload);
}

const roomsReached = () => [...new Set(published.map((p) => p.room))].sort();

describe("a person's chat frames reach only the people who may read it", () => {
  beforeEach(() => {
    handlers.clear();
    emitted.length = 0;
    published.length = 0;
    admins.clear();
    admins.set('p-1', [ADMIN]);
    provideEphemeralPublisher(publishEphemeralFrame);
    registerWsBroadcastSubscribers();
  });

  it.each([
    [
      'agent-session.turn.appended',
      () => broadcastTurnAppended(personChat, { turnId: 't-1', turnIndex: 0, role: 'user' }),
    ],
    ['agent-session.turn.truncated', () => broadcastTurnTruncated(personChat, 2)],
    ['agent-session.status', () => broadcastSession(personChat, 'agent-session.status')],
    ['agent-session.updated', () => broadcastSession(personChat, 'agent-session.updated')],
  ])('%s goes to the owner and admins, never the project or box room', async (event, fire) => {
    fire();
    await settle();
    expect(published.every((p) => p.event === event)).toBe(true);
    expect(roomsReached()).toEqual([`user:${ADMIN}`, `user:${OWNER}`]);
    expect(roomsReached()).not.toContain(`user:${MEMBER}`);
    expect(roomsReached()).not.toContain('project:p-1');
    expect(roomsReached()).not.toContain('device:d-1');
  });

  it('a pipeline session keeps its project and box audience', async () => {
    broadcastSession({ ...personChat, kind: 'pipeline' }, 'agent-session.status');
    await settle();
    expect(roomsReached()).toEqual(['device:d-1', 'project:p-1']);
  });

  it('a chat a schedule opened (unattended) stays project-wide', async () => {
    broadcastTurnAppended(
      { ...personChat, metadata: { unattended: true } },
      { turnId: 't-1', turnIndex: 0, role: 'assistant' },
    );
    await settle();
    expect(roomsReached()).toEqual(['device:d-1', 'project:p-1']);
  });

  it('a session.changed for a private chat is told only to the named people', async () => {
    await handlers.get('session.changed')?.({
      sessionId: 's-chat',
      projectId: 'p-1',
      deviceId: 'd-1',
      event: 'agent-session.status',
      extra: { status: 'completed' },
      projectWide: false,
      userIds: [OWNER],
    });
    expect(roomsReached()).toEqual([`user:${OWNER}`]);
  });
});

describe('the read gate names the same chats the frames hide', () => {
  const member = {
    projectId: 'p-1',
    orgId: 'o-1',
    orgRole: null,
    role: 'member' as const,
    grants: [],
  };
  it("refuses a member reading another person's chat", () => {
    expect(() => assertAgentChatOwner(personChat, member, MEMBER)).toThrow(
      /only the conversation's owner/,
    );
  });
  it('admits the owner, and admits anyone to an unattended chat', () => {
    expect(() => assertAgentChatOwner(personChat, member, OWNER)).not.toThrow();
    expect(() =>
      assertAgentChatOwner({ ...personChat, metadata: { unattended: true } }, member, MEMBER),
    ).not.toThrow();
  });
});
