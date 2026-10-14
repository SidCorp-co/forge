import { describe, expect, it } from 'vitest';
import { decodeSessionCursor, encodeSessionCursor, SessionCursorInvalidError } from './cursor.js';

const id = '3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8';
const key = '2026-10-14T09:15:39.611123Z';
const token = (raw: string) => Buffer.from(raw, 'utf8').toString('base64url');

describe('the agent-session cursor', () => {
  it('round-trips the microsecond key and the id', () => {
    expect(decodeSessionCursor(encodeSessionCursor({ updatedAtKey: key, id }))).toEqual({
      updatedAtKey: key,
      id,
    });
  });

  it.each([
    ['no separator', token('nothing'), 'not an agent-session cursor'],
    ['a non-uuid id', token(`${key}|not-a-uuid`), 'no session id'],
    ['an unparseable timestamp', token(`yesterday|${id}`), 'no timestamp'],
    [
      'a date the calendar does not have',
      token(`2026-02-30T00:00:00.000000Z|${id}`),
      'no timestamp',
    ],
    [
      'year zero, which Postgres refuses',
      token(`0000-01-01T00:00:00.000000Z|${id}`),
      'no timestamp',
    ],
    ['an hour the clock does not have', token(`2026-10-14T25:00:00.000000Z|${id}`), 'no timestamp'],
    [
      'a timestamp that is not the minted shape',
      token(`2026-10-14T09:15:39Z|${id}`),
      'no timestamp',
    ],
    ['an empty token', '', 'not an agent-session cursor'],
  ])('refuses %s by name', (_why, bad, message) => {
    expect(() => decodeSessionCursor(bad)).toThrow(SessionCursorInvalidError);
    expect(() => decodeSessionCursor(bad)).toThrow(message);
  });
});
