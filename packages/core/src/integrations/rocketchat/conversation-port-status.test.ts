/**
 * ISS-1088 — the Rocket.Chat port's two additions: a reply addressed to the
 * asker and threaded under the message it answers, and the acknowledgement
 * shown through the same connection that answers.
 *
 * The mock header is `conversation-port.test.ts`'s, which was at its line
 * ceiling.
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
const reactToMessage = vi.fn(async (..._a: unknown[]) => true);
vi.mock('./rest-client.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    fetchRoomHistory: (...a: unknown[]) => fetchRoomHistory(...a),
    fetchThreadMessages: (...a: unknown[]) => fetchThreadMessages(...a),
    reactToMessage: (...a: unknown[]) => reactToMessage(...a),
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

const { RECEIVED_EMOJI, rocketChatConversationPorts } = await import('./conversation-port.js');
const { clearLiveConnections, liveConnectionFor, registerLiveConnection } = await import(
  './live-connections.js'
);
const { codeAuthored } = await import('../../conversations/ports.js');

const AUTH = { serverUrl: 'https://chat.example.co', authToken: 't', userId: 'bot' };
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  clearLiveConnections();
  reactToMessage.mockResolvedValue(true);
  connections = [
    {
      id: 'conn-1',
      config: { serverUrl: AUTH.serverUrl },
      secrets: { authToken: 't', userId: 'bot' },
    },
  ];
  bindings = [{ connectionId: 'conn-1', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } }];
});

describe('the addressed reply and the anchored status (ISS-1088 criteria 20-22)', () => {
  const room = {
    adapter: 'rocketchat' as const,
    externalId: 'chat.example.co ROOM1',
    shape: 'group' as const,
    projectId: PROJECT_ID,
  };

  it('prefixes the addressee after the screen and reports the delivered text', async () => {
    const receipt = await rocketChatConversationPorts.deliver(
      room,
      codeAuthored('the build is green'),
      {
        addressee: 'alice',
      },
    );
    expect(sendFixedReply.mock.calls[0]?.[1]).toBe('@alice the build is green');
    expect(receipt).toEqual({ messageId: 'rc-msg-1', deliveredText: '@alice the build is green' });
  });

  it('reports no deliveredText when nothing was added', async () => {
    const receipt = await rocketChatConversationPorts.deliver(room, codeAuthored('plain'), {
      addressee: null,
    });
    expect(receipt).toEqual({ messageId: 'rc-msg-1' });
  });

  it('threads an anchored delivery under the anchor when the venue is the room itself', async () => {
    await rocketChatConversationPorts.deliver(room, codeAuthored('status'), { anchor: 'rc-ask-1' });
    expect(sendFixedReply.mock.calls[0]?.[0]).toMatchObject({ rid: 'ROOM1', tmid: 'rc-ask-1' });
  });

  it('keeps the venue’s own thread when it already is one', async () => {
    await rocketChatConversationPorts.deliver(
      { ...room, externalId: 'chat.example.co ROOM1 T9' },
      codeAuthored('status'),
      { anchor: 'rc-ask-1' },
    );
    expect(sendFixedReply.mock.calls[0]?.[0]).toMatchObject({ rid: 'ROOM1', tmid: 'T9' });
  });
});

describe('acknowledge (ISS-1088 criteria 23-27, 30)', () => {
  const room = {
    adapter: 'rocketchat' as const,
    externalId: 'chat.example.co ROOM1',
    shape: 'group' as const,
    projectId: PROJECT_ID,
  };
  const notifyUserActivity = vi.fn(async (..._a: unknown[]) => undefined);
  const live = (over: Partial<{ username: string | null; displayName: string | null }> = {}) =>
    registerLiveConnection('conn-1', {
      namespace: 'chat.example.co',
      client: { notifyUserActivity, getState: () => 'live' as const },
      username: 'babo',
      displayName: 'Babo Bot',
      ...over,
    });

  beforeEach(() => {
    notifyUserActivity.mockReset();
    notifyUserActivity.mockResolvedValue(undefined);
  });

  it('marks received with the eyes reaction as a setter, on and off, through the room’s connection (criteria 23, 25, 30)', async () => {
    await rocketChatConversationPorts.acknowledge?.(room, {
      kind: 'received',
      messageId: 'rc-1',
      on: true,
    });
    await rocketChatConversationPorts.acknowledge?.(room, {
      kind: 'received',
      messageId: 'rc-1',
      on: false,
    });
    expect(RECEIVED_EMOJI).toBe('eyes');
    expect(reactToMessage.mock.calls).toEqual([
      [expect.objectContaining({ userId: 'bot' }), 'rc-1', 'eyes', true],
      [expect.objectContaining({ userId: 'bot' }), 'rc-1', 'eyes', false],
    ]);
  });

  it('logs a refused reaction and throws nothing', async () => {
    reactToMessage.mockResolvedValue(false);
    await expect(
      rocketChatConversationPorts.acknowledge?.(room, {
        kind: 'received',
        messageId: 'rc-1',
        on: true,
      }),
    ).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'rc-1' }),
      expect.stringContaining('refused the receipt reaction'),
    );
  });

  it('shows working through the live socket under the bot’s username (criteria 24, 25)', async () => {
    live();
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: false });
    expect(notifyUserActivity.mock.calls).toEqual([
      ['ROOM1', 'babo', true],
      ['ROOM1', 'babo', false],
    ]);
  });

  it('does nothing for working on a registered socket that is no longer live (pass B F1)', async () => {
    registerLiveConnection('conn-1', {
      namespace: 'chat.example.co',
      client: { notifyUserActivity, getState: () => 'closed' as const },
      username: 'babo',
      displayName: 'Babo Bot',
    });
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    expect(notifyUserActivity).not.toHaveBeenCalled();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('does nothing for working where this core holds no live client for the room’s connection (criterion 25)', async () => {
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    expect(notifyUserActivity).not.toHaveBeenCalled();
    registerLiveConnection('conn-other', {
      namespace: 'chat.example.co',
      client: { notifyUserActivity, getState: () => 'live' as const },
      username: 'other',
      displayName: null,
    });
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    expect(notifyUserActivity).not.toHaveBeenCalled();
  });

  it('retries once under the display name when the username is refused (criterion 26)', async () => {
    live();
    notifyUserActivity.mockRejectedValueOnce(new Error('error-invalid-user'));
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    expect(notifyUserActivity.mock.calls).toEqual([
      ['ROOM1', 'babo', true],
      ['ROOM1', 'Babo Bot', true],
    ]);
    expect(loggerWarn).not.toHaveBeenCalled();
    expect(liveConnectionFor('conn-1')?.activityRefused).toBe(false);
  });

  it('after a refusal under both names, logs once and stops trying on that connection (criterion 27)', async () => {
    live();
    notifyUserActivity.mockRejectedValue(new Error('error-invalid-user'));
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: false });
    expect(notifyUserActivity).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(liveConnectionFor('conn-1')?.activityRefused).toBe(true);
    // a redial registers afresh and forgets the refusal
    live();
    expect(liveConnectionFor('conn-1')?.activityRefused).toBe(false);
  });

  it('shows activity on the SAME connection that answers when two bind the room (criterion 26; consult F6)', async () => {
    connections = [
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
      { connectionId: 'conn-b', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } },
      { connectionId: 'conn-a', projectId: PROJECT_ID, config: { rids: ['ROOM1'] } },
    ];
    const notifyA = vi.fn(async () => undefined);
    const notifyB = vi.fn(async () => undefined);
    registerLiveConnection('conn-a', {
      namespace: 'chat.example.co',
      client: { notifyUserActivity: notifyA, getState: () => 'live' as const },
      username: 'bot-a',
      displayName: null,
    });
    registerLiveConnection('conn-b', {
      namespace: 'chat.example.co',
      client: { notifyUserActivity: notifyB, getState: () => 'live' as const },
      username: 'bot-b',
      displayName: null,
    });
    await rocketChatConversationPorts.acknowledge?.(room, { kind: 'working', on: true });
    await rocketChatConversationPorts.acknowledge?.(room, {
      kind: 'received',
      messageId: 'rc-1',
      on: true,
    });
    await rocketChatConversationPorts.deliver(room, codeAuthored('answer'));
    expect(notifyA).toHaveBeenCalledTimes(1);
    expect(notifyB).not.toHaveBeenCalled();
    expect(reactToMessage.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual([
      'bot-a',
    ]);
    expect(
      sendFixedReply.mock.calls.map((c) => (c[0] as { auth: { userId: string } }).auth.userId),
    ).toEqual(['bot-a']);
  });

  it('ignores a venue id that is not Rocket.Chat’s, and a room with no connection', async () => {
    await rocketChatConversationPorts.acknowledge?.(
      { ...room, externalId: 'nonsense' },
      { kind: 'working', on: true },
    );
    bindings = [];
    await rocketChatConversationPorts.acknowledge?.(room, {
      kind: 'received',
      messageId: 'rc-1',
      on: true,
    });
    expect(reactToMessage).not.toHaveBeenCalled();
  });
});
