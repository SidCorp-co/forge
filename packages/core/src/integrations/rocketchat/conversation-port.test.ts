/**
 * ISS-1001 — Rocket.Chat as the first adapter, tested at the seam the store
 * sees: a venue key, a speaker, and one outbound door.
 *
 * The key's test is the one that matters. A rid is unique inside ONE
 * Rocket.Chat installation, so the same rid on two servers is two rooms; the
 * planted collision here is what the namespace prefix exists for, and it goes
 * red if the prefix is ever dropped.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRoomShape = vi.fn();
vi.mock('./room-shape.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, resolveRoomShape: (...a: unknown[]) => fetchRoomShape(...a) };
});

const sendFixedReply = vi.fn(async (..._a: unknown[]) => ({ messageId: 'rc-msg-1' }));
vi.mock('./outbound.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return { ...actual, sendFixedReply: (...a: unknown[]) => sendFixedReply(...a) };
});

const fetchRoomHistory = vi.fn();
const fetchThreadMessages = vi.fn();
vi.mock('./rest-client.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    fetchRoomHistory: (...a: unknown[]) => fetchRoomHistory(...a),
    fetchThreadMessages: (...a: unknown[]) => fetchThreadMessages(...a),
  };
});

const loggerWarn = vi.fn();
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: vi.fn(),
  },
}));

const resolveForgeSpeaker = vi.fn();
vi.mock('../../assistant/identity/speaker-link.js', () => ({
  resolveSpeaker: (...a: unknown[]) => resolveForgeSpeaker(...a),
}));

/** The active `rocketchat` connections and bindings `authForVenue` scans, in that query order. */
let connections: Array<{ id: string; config: { serverUrl: string }; secrets: unknown }> = [];
let bindings: Array<{ connectionId: string; projectId: string; config: { rids?: string[] } }> = [];
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        // cm:why the mock answers by TABLE and not by call order: the two queries are issued in a fixed order today and a counter would silently re-point if that ever changed.
        where: async () =>
          String((table as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')]) ===
          'integration_bindings'
            ? bindings
            : connections,
      }),
    }),
  },
}));
vi.mock('../store.js', () => ({
  decryptConnectionSecrets: (row: { secrets: unknown }) => row.secrets,
}));

const { parseRocketChatVenueId, rocketChatConversationPorts, rocketChatVenueId } = await import(
  './conversation-port.js'
);
const { codeAuthored, screened } = await import('../../conversations/ports.js');

const AUTH = { serverUrl: 'https://chat.example.co', authToken: 't', userId: 'bot' };
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '22222222-2222-4222-8222-222222222222';

function frame(over: Record<string, unknown> = {}) {
  return {
    m: { rid: 'ROOM1', msg: 'hi', userId: 'u1', username: 'ana', _id: 'm1' },
    auth: AUTH,
    projectId: PROJECT_ID,
    shape: 'direct' as const,
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  connections = [
    {
      id: 'conn-1',
      config: { serverUrl: AUTH.serverUrl },
      secrets: { authToken: 't', userId: 'bot' },
    },
  ];
  // cm:why every delivery needs a binding naming the venue's own project: a binding is what says this room belongs to this project TODAY, and a connection alone cannot say it.
  bindings = [{ connectionId: 'conn-1', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } }];
});

describe('the venue key', () => {
  it('carries the server, so one rid on two installations is two venues', () => {
    const here = rocketChatVenueId('chat.example.co', 'ROOM1');
    const there = rocketChatVenueId('chat.other.io', 'ROOM1');
    expect(here).not.toBe(there);
  });

  it('separates a thread from the room it hangs under', () => {
    expect(rocketChatVenueId('chat.example.co', 'ROOM1', 'T9')).not.toBe(
      rocketChatVenueId('chat.example.co', 'ROOM1'),
    );
  });

  it('reads back exactly what was written, thread or no thread', () => {
    expect(parseRocketChatVenueId(rocketChatVenueId('chat.example.co', 'ROOM1'))).toEqual({
      namespace: 'chat.example.co',
      rid: 'ROOM1',
      tmid: null,
    });
    expect(parseRocketChatVenueId(rocketChatVenueId('chat.example.co', 'ROOM1', 'T9'))).toEqual({
      namespace: 'chat.example.co',
      rid: 'ROOM1',
      tmid: 'T9',
    });
  });

  it('refuses a string that is not one of its keys', () => {
    expect(parseRocketChatVenueId('ROOM1')).toBeNull();
    expect(parseRocketChatVenueId('a b c d')).toBeNull();
    expect(parseRocketChatVenueId(' ROOM1')).toBeNull();
  });
});

describe('resolveVenue', () => {
  it('takes the caller resolved shape without asking the server again', async () => {
    const venue = await rocketChatConversationPorts.resolveVenue(frame({ shape: 'group' }));
    expect(venue).toEqual({
      adapter: 'rocketchat',
      externalId: 'chat.example.co ROOM1',
      shape: 'group',
      projectId: PROJECT_ID,
    });
    expect(fetchRoomShape).not.toHaveBeenCalled();
  });

  it('resolves the shape itself when the caller has none', async () => {
    fetchRoomShape.mockResolvedValue('direct');
    const venue = await rocketChatConversationPorts.resolveVenue(frame({ shape: undefined }));
    expect(venue?.shape).toBe('direct');
    expect(fetchRoomShape).toHaveBeenCalledOnce();
  });

  it('answers null rather than a guessed shape when the room type cannot be read', async () => {
    fetchRoomShape.mockResolvedValue(null);
    expect(await rocketChatConversationPorts.resolveVenue(frame({ shape: undefined }))).toBeNull();
  });

  it('answers null when the server address is not a readable namespace', async () => {
    const venue = await rocketChatConversationPorts.resolveVenue(
      frame({ auth: { ...AUTH, serverUrl: 'not a url' } }),
    );
    expect(venue).toBeNull();
  });
});

describe('resolveSpeaker', () => {
  it('refuses by name when the server address is not a readable namespace', async () => {
    const r = await rocketChatConversationPorts.resolveSpeaker(
      frame({ auth: { ...AUTH, serverUrl: 'not a url' } }),
    );
    expect(r).toMatchObject({ linked: false, refusal: { code: 'SPEAKER_DIRECTORY_UNREACHABLE' } });
    expect(resolveForgeSpeaker).not.toHaveBeenCalled();
  });

  it('hands the assistant resolver the namespace and the speaker', async () => {
    resolveForgeSpeaker.mockResolvedValue({ linked: true, userId: 'u-forge' });
    await rocketChatConversationPorts.resolveSpeaker(frame());
    expect(resolveForgeSpeaker).toHaveBeenCalledWith({
      source: 'rocketchat',
      namespace: 'chat.example.co',
      externalId: 'u1',
      label: 'ana',
    });
  });
});

describe('deliver', () => {
  const venue = {
    adapter: 'rocketchat' as const,
    externalId: 'chat.example.co ROOM1 T9',
    shape: 'group' as const,
    projectId: PROJECT_ID,
  };

  it('posts through the one outbound door, to the room and the thread in the key', async () => {
    const receipt = await rocketChatConversationPorts.deliver(venue, codeAuthored('answer'));
    expect(receipt).toEqual({ messageId: 'rc-msg-1' });
    expect(sendFixedReply).toHaveBeenCalledWith(
      { kind: 'rest', auth: AUTH, rid: 'ROOM1', tmid: 'T9' },
      'answer',
      expect.anything(),
    );
  });

  it('carries a screened text with its own problems as the proof', async () => {
    const message = screened('answer', { ok: true, problems: ['tone'] });
    expect(message).not.toBeNull();
    await rocketChatConversationPorts.deliver(venue, message as never);
    expect((sendFixedReply.mock.calls[0] as unknown[])[2]).toEqual({
      ok: true,
      problems: ['tone'],
    });
  });

  it('refuses by name when no active connection serves the venue server', async () => {
    connections = [];
    await expect(rocketChatConversationPorts.deliver(venue, codeAuthored('x'))).rejects.toThrow(
      /no active connection on chat\.example\.co/,
    );
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  // cm:guard a conversation outlives the binding that opened it: this is the rebind, and the old project's delayed answer must not reach a room somebody else now owns (ISS-1001).
  it('refuses when the room is now bound to another project', async () => {
    bindings = [
      { connectionId: 'conn-1', projectId: OTHER_PROJECT_ID, config: { rids: ['ROOM1'] } },
    ];
    await expect(rocketChatConversationPorts.deliver(venue, codeAuthored('x'))).rejects.toThrow(
      /holds a binding for room ROOM1 under project 11111111-1111-4111-8111-111111111111/,
    );
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  it('refuses when the one connection on the server has no binding for the room at all', async () => {
    bindings = [];
    await expect(rocketChatConversationPorts.deliver(venue, codeAuthored('x'))).rejects.toThrow(
      /rebound since this conversation was opened/,
    );
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  // cm:guard one installation can be served by TWO Forge connections under two bot accounts: posting as whichever matched the server first posts as a bot the room may not even hold.
  it('posts as the bot whose binding names the room, not the first bot on the server', async () => {
    connections = [
      {
        id: 'conn-1',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'wrong', userId: 'bot-a' },
      },
      {
        id: 'conn-2',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'right', userId: 'bot-b' },
      },
    ];
    bindings = [{ connectionId: 'conn-2', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } }];

    await rocketChatConversationPorts.deliver(venue, codeAuthored('answer'));

    expect(sendFixedReply.mock.calls[0]?.[0]).toMatchObject({
      auth: { authToken: 'right', userId: 'bot-b' },
    });
  });

  it('refuses when two connections share the server and neither binding names the room', async () => {
    connections = [
      {
        id: 'conn-1',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'a', userId: 'bot-a' },
      },
      {
        id: 'conn-2',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'b', userId: 'bot-b' },
      },
    ];
    bindings = [
      { connectionId: 'conn-2', projectId: PROJECT_ID, config: { rids: ['SOMEWHERE-ELSE'] } },
    ];

    await expect(rocketChatConversationPorts.deliver(venue, codeAuthored('x'))).rejects.toThrow(
      /no active connection on chat\.example\.co holds a binding for room ROOM1/,
    );
    expect(sendFixedReply).not.toHaveBeenCalled();
  });

  // cm:guard the ONE door resolves its own credential from the venue, so a room whose original connection has lost the binding is answered by whichever connection still holds it rather than going silent: the guard the venue carries is the PROJECT's ownership of the room, not which socket the message arrived on (ISS-1002 gave up that affinity deliberately).
  it('answers through the second connection when the first no longer binds the room', async () => {
    connections = [
      {
        id: 'conn-1',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'gone', userId: 'bot-a' },
      },
      {
        id: 'conn-2',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'still-here', userId: 'bot-b' },
      },
    ];
    bindings = [{ connectionId: 'conn-2', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } }];

    await rocketChatConversationPorts.deliver(venue, codeAuthored('answer'));

    expect(sendFixedReply.mock.calls[0]?.[0]).toMatchObject({
      auth: { authToken: 'still-here', userId: 'bot-b' },
    });
  });

  // cm:guard the pick among several is ORDERED and said out loud: an unordered one makes the bot a room is answered by change between two consecutive replies for no reason a reader could find, and the row order a database returns is not a decision anybody made.
  it('answers through the same connection every time when two of them bind the room', async () => {
    const both = [
      {
        id: 'conn-b',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'b', userId: 'bot-b' },
      },
      {
        id: 'conn-a',
        config: { serverUrl: AUTH.serverUrl },
        secrets: { authToken: 'a', userId: 'bot-a' },
      },
    ];
    bindings = [
      { connectionId: 'conn-a', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } },
      { connectionId: 'conn-b', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } },
    ];

    connections = both;
    await rocketChatConversationPorts.deliver(venue, codeAuthored('answer'));
    connections = [...both].reverse();
    await rocketChatConversationPorts.deliver(venue, codeAuthored('answer'));

    expect(
      sendFixedReply.mock.calls.map((c) => (c[0] as { auth: { userId: string } }).auth.userId),
    ).toEqual(['bot-a', 'bot-a']);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionIds: ['conn-a', 'conn-b'] }),
      expect.stringContaining('more than one active connection binds this room'),
    );
  });

  it('refuses a venue key that is not a Rocket.Chat one', async () => {
    await expect(
      rocketChatConversationPorts.deliver({ ...venue, externalId: 'ROOM1' }, codeAuthored('x')),
    ).rejects.toThrow(/is not a Rocket\.Chat venue id/);
  });
});

describe('fetchHistory', () => {
  const room = {
    adapter: 'rocketchat' as const,
    externalId: 'chat.example.co ROOM1',
    shape: 'group' as const,
    projectId: PROJECT_ID,
  };

  it('reads the room when the key names no thread', async () => {
    fetchRoomHistory.mockResolvedValue([
      { text: 'hello', userId: 'u1', username: 'ana', isSystem: false },
      { text: 'hi', userId: 'bot', username: 'forge', isSystem: false },
    ]);
    expect(await rocketChatConversationPorts.fetchHistory(room, 20)).toEqual([
      { role: 'user', authorLabel: 'ana', content: 'hello' },
      { role: 'assistant', authorLabel: 'forge', content: 'hi' },
    ]);
    expect(fetchRoomHistory).toHaveBeenCalledWith(AUTH, 'ROOM1', { count: 20 });
  });

  it('reads the thread when the key names one', async () => {
    fetchThreadMessages.mockResolvedValue([]);
    await rocketChatConversationPorts.fetchHistory(
      { ...room, externalId: 'chat.example.co ROOM1 T9' },
      5,
    );
    expect(fetchThreadMessages).toHaveBeenCalledWith(AUTH, 'T9', 5);
    expect(fetchRoomHistory).not.toHaveBeenCalled();
  });

  it('reads nothing when the room is bound to another project now', async () => {
    bindings = [
      { connectionId: 'conn-1', projectId: OTHER_PROJECT_ID, config: { rids: ['ROOM1'] } },
    ];
    expect(await rocketChatConversationPorts.fetchHistory(room, 20)).toEqual([]);
    expect(fetchRoomHistory).not.toHaveBeenCalled();
  });

  it('drops system rows and blank text rather than carrying them into a prompt', async () => {
    fetchRoomHistory.mockResolvedValue([
      { text: 'joined', userId: 'u1', username: 'ana', isSystem: true },
      { text: '   ', userId: 'u1', username: 'ana', isSystem: false },
      { text: 'real', userId: 'u1', username: null, isSystem: false },
    ]);
    expect(await rocketChatConversationPorts.fetchHistory(room, 20)).toEqual([
      { role: 'user', authorLabel: null, content: 'real' },
    ]);
  });
});
