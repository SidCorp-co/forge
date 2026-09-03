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
vi.mock('../../db/client.js', () => ({ db: {} }));

const { extractFinalAssistantText, readRoomReplyMeta } = await import('./room-delivery.js');

describe('extractFinalAssistantText', () => {
  it('reads the desktop/chat shape (entry.role)', () => {
    const text = extractFinalAssistantText([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'the answer' },
    ]);
    expect(text).toBe('the answer');
  });

  it('reads the CLI-runner shape (entry.type, no role)', () => {
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
      deliveredAt: null,
    });
  });
});
