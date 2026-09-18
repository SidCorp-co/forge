/**
 * The shared half of the two RC completion bridges. The pure pieces are
 * covered here so both bridges inherit one set of guarantees: the
 * marker-parameterized metadata reader (whose three routing fields must read
 * as "not ours" rather than default — a defaulted `rid` would post into an
 * empty room id) and final-assistant-text extraction across both on-disk
 * message shapes. `config/env.js` and `db/client.js` are stubbed because the
 * module graph validates env eagerly at import.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
/** The active `rocketchat` bindings the query would return, already narrowed by its WHERE. */
let bindingRows: Array<{ config: { rids?: string[] } }> = [];
let lastWhere: unknown;
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async (w: unknown) => {
          lastWhere = w;
          return bindingRows;
        },
      }),
    }),
  },
}));

const { extractFinalAssistantText, readRoomReplyMeta, roomStillBoundTo } = await import(
  './room-delivery.js'
);

// cm:guard the rule every path that posts from a STORED rid depends on: a session records the room
// it began in, and the binding that put it there can move while the work runs (ISS-1001).
describe('roomStillBoundTo', () => {
  const args = { connectionId: 'conn-1', projectId: 'proj-1', rid: 'ROOM1' };

  it('is true when an active binding of that connection and project names the room', async () => {
    bindingRows = [{ config: { rids: ['ROOM9', 'ROOM1'] } }];
    expect(await roomStillBoundTo(args)).toBe(true);
    expect(lastWhere).toBeDefined();
  });

  it('is false when the connection and project match but the room is not in the binding', async () => {
    bindingRows = [{ config: { rids: ['ROOM9'] } }];
    expect(await roomStillBoundTo(args)).toBe(false);
  });

  it('is false when nothing on that connection is bound to that project at all', async () => {
    bindingRows = [];
    expect(await roomStillBoundTo(args)).toBe(false);
  });

  it('is false when the binding carries no room list rather than treating it as all rooms', async () => {
    bindingRows = [{ config: {} }];
    expect(await roomStillBoundTo(args)).toBe(false);
  });
});

describe('extractFinalAssistantText', () => {
  // cm:guard a legacy `role` entry answers NOTHING, and this assertion is the
  // point rather than a tautology: this reader discriminates through
  // `messageRoleToTurnRole`, which lost its `role` branch in ISS-1030. Every row
  // at rest was rewritten and what an old daemon sends is converted on the way
  // in, so a `role` entry reaching here is a conversion that did not happen — and
  // answering it would hide that by making the legacy path work anyway.
  it('does not read a legacy `role` entry — the conversion happens before this', () => {
    const text = extractFinalAssistantText([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'the answer' },
    ]);
    expect(text).toBeNull();
  });

  it('reads the canonical shape (entry.type)', () => {
    const text = extractFinalAssistantText([
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'the answer' },
    ]);
    expect(text).toBe('the answer');
  });

  it('skips trailing empty-content entries to find the last real answer', () => {
    const text = extractFinalAssistantText([
      { type: 'assistant', content: 'the real answer' },
      { type: 'assistant', content: '' },
    ]);
    expect(text).toBe('the real answer');
  });

  it('returns null when there is no assistant text at all', () => {
    expect(extractFinalAssistantText([{ type: 'user', content: 'hi' }])).toBeNull();
    expect(extractFinalAssistantText(null)).toBeNull();
  });
});

describe('readRoomReplyMeta', () => {
  const full = {
    connectionId: 'conn-1',
    rid: 'room-1',
    tmid: 'thread-1',
    botName: 'Babo',
    askedByUsername: 'alice',
    question: 'How does X work?',
    deliveredAt: '2026-01-01T00:00:00.000Z',
  };

  it('reads the marker it is asked for, not the other one', () => {
    const metadata = { escalation: full, agentChat: { ...full, rid: 'room-2' } };
    expect(readRoomReplyMeta(metadata, 'escalation')?.rid).toBe('room-1');
    expect(readRoomReplyMeta(metadata, 'agentChat')?.rid).toBe('room-2');
  });

  it('returns null when the requested marker is absent', () => {
    expect(readRoomReplyMeta({ escalation: full }, 'agentChat')).toBeNull();
    expect(readRoomReplyMeta({}, 'escalation')).toBeNull();
    expect(readRoomReplyMeta(null, 'escalation')).toBeNull();
  });

  it.each(['connectionId', 'rid', 'botName'] as const)(
    'returns null when the routing field %s is missing — never a defaulted empty string',
    (field) => {
      const partial: Record<string, unknown> = { ...full };
      delete partial[field];
      expect(readRoomReplyMeta({ agentChat: partial }, 'agentChat')).toBeNull();
    },
  );

  it('degrades the cosmetic fields instead of rejecting the session', () => {
    const meta = readRoomReplyMeta(
      { agentChat: { connectionId: 'c', rid: 'r', botName: 'Babo' } },
      'agentChat',
    );
    expect(meta).toEqual({
      connectionId: 'c',
      rid: 'r',
      tmid: null,
      botName: 'Babo',
      askedByUsername: '',
      question: '',
      shape: null,
      principalUserId: null,
      deliveredAt: null,
    });
  });

  // cm:why null and not a default: a `direct` row whose principal reads as the organization's creator is the substitution ISS-987's authority rule exists to refuse, so an absent field has to stay distinguishable from a present one
  it('reads the shape and the stored speaker back when the row carries them', () => {
    const meta = readRoomReplyMeta(
      {
        agentChat: {
          connectionId: 'c',
          rid: 'r',
          botName: 'Babo',
          shape: 'direct',
          principalUserId: 'speaker-user-9',
        },
      },
      'agentChat',
    );
    expect(meta?.shape).toBe('direct');
    expect(meta?.principalUserId).toBe('speaker-user-9');
  });

  it('refuses a shape it does not know rather than carrying it through', () => {
    const meta = readRoomReplyMeta(
      { agentChat: { connectionId: 'c', rid: 'r', botName: 'Babo', shape: 'thread' } },
      'agentChat',
    );
    expect(meta?.shape).toBeNull();
  });
});
