/**
 * ISS-1051 — rows are tied to sends by the boundaries the runner snapshots, never by reply text:
 * two sends saying the same thing, a repair behind one send, and an empty reply behind a fallback
 * all attribute exactly once, and evidence the boundaries cannot place is refused by row id.
 */

import { describe, expect, it } from 'vitest';
import { type ChatLogRow, pairTrail, readAttempt } from './trail.js';

const ROOM = 'room-1';
const row = (id: string, over: Partial<ChatLogRow> = {}): ChatLogRow => ({
  id,
  sessionId: ROOM,
  reply: 'same words',
  toolCalls: [],
  iterations: 1,
  durationMs: 10,
  error: null,
  createdAt: '2026-09-16T00:00:00.000Z',
  ...over,
});

describe('pairTrail', () => {
  it('attributes two sends with equal replies once each', () => {
    const rows = [row('a'), row('b')];
    const sends = pairTrail(ROOM, rows, [[], ['a'], ['a', 'b']]);
    expect(sends.map((s) => s.map((a) => a.chatLogId))).toEqual([['a'], ['b']]);
  });

  it('keeps a screen repair as a second attempt of the same send', () => {
    const rows = [row('a', { reply: 'rejected text' }), row('b', { reply: 'rewritten' }), row('c')];
    const sends = pairTrail(ROOM, rows, [[], ['a', 'b'], ['a', 'b', 'c']]);
    expect(sends[0]?.map((a) => a.reply)).toEqual(['rejected text', 'rewritten']);
    expect(sends[1]?.map((a) => a.chatLogId)).toEqual(['c']);
  });

  it('keeps an empty raw reply the door replaced with a fallback', () => {
    const rows = [row('a', { reply: null, error: 'empty-reply' })];
    const [send] = pairTrail(ROOM, rows, [[], ['a']]);
    expect(send).toEqual([
      expect.objectContaining({ chatLogId: 'a', reply: null, error: 'empty-reply' }),
    ]);
  });

  it('reports a send with no row as an empty attempt list', () => {
    expect(pairTrail(ROOM, [], [[], []])).toEqual([[]]);
  });

  it('ignores rows of other rooms', () => {
    const rows = [row('a'), row('z', { sessionId: 'room-2' })];
    expect(pairTrail(ROOM, rows, [[], ['a']])).toHaveLength(1);
  });

  it('refuses a room row no boundary places, by id', () => {
    expect(() => pairTrail(ROOM, [row('a'), row('b')], [[], ['a']])).toThrow(
      'chat_logs row b belongs to room room-1 but no send boundary places it',
    );
  });

  it('refuses a boundary id the trail read does not hold, by id', () => {
    expect(() => pairTrail(ROOM, [row('a')], [[], ['a', 'ghost']])).toThrow(
      'send 1 boundary names chat_logs row ghost, which the trail read does not hold',
    );
  });
});

describe('readAttempt', () => {
  it('reads the forge tool argv and leaves other tools with argv null', () => {
    const attempt = readAttempt(
      row('a', {
        iterations: 3,
        durationMs: 1234,
        toolCalls: [
          {
            name: 'forge',
            arguments: '{"argv":["issue","--status","open"]}',
            isError: false,
            durationMs: 40,
          },
          {
            name: 'forge_preferences',
            arguments: '{"answerStyle":"bullets"}',
            isError: true,
            durationMs: 2,
          },
          { name: 'forge', arguments: 'not json' },
        ],
      }),
    );
    expect(attempt.iterations).toBe(3);
    expect(attempt.ms).toBe(1234);
    expect(attempt.calls.map((c) => [c.name, c.argv, c.isError, c.durationMs])).toEqual([
      ['forge', ['issue', '--status', 'open'], false, 40],
      ['forge_preferences', null, true, 2],
      ['forge', null, false, 0],
    ]);
  });

  it('reads a row whose toolCalls is not a list as no calls', () => {
    expect(
      readAttempt(row('a', { toolCalls: null, iterations: null, durationMs: null })).calls,
    ).toEqual([]);
  });
});
