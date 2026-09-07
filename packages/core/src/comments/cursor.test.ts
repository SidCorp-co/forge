import { describe, expect, it } from 'vitest';
import {
  CommentCursorInvalidError,
  decodeCommentCursor,
  encodeCommentCursor,
} from './cursor.js';

const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

describe('comment cursor codec (ISS-956)', () => {
  it('round-trips the createdAt and the id', () => {
    const at = new Date('2026-09-06T18:58:11.123Z');
    const back = decodeCommentCursor(encodeCommentCursor({ createdAt: at, id: ID }));
    expect(back.createdAt.toISOString()).toBe(at.toISOString());
    expect(back.id).toBe(ID);
  });

  it('distinguishes two comments written in the same millisecond', () => {
    const at = new Date('2026-09-06T18:58:11.000Z');
    expect(encodeCommentCursor({ createdAt: at, id: ID })).not.toBe(
      encodeCommentCursor({ createdAt: at, id: OTHER }),
    );
  });

  it('is URL-safe — no padding or +/ characters to re-encode', () => {
    const token = encodeCommentCursor({ createdAt: new Date(0), id: ID });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('refuses a token that is not base64 of <iso>|<uuid>', () => {
    expect(() => decodeCommentCursor('not-a-cursor')).toThrow(CommentCursorInvalidError);
  });

  it('refuses a token whose id half is not a uuid', () => {
    const forged = Buffer.from('2026-09-06T18:58:11.000Z|nope', 'utf8').toString('base64url');
    expect(() => decodeCommentCursor(forged)).toThrow(/no comment id/);
  });

  it('refuses a token whose timestamp half is not a date', () => {
    const forged = Buffer.from(`never|${ID}`, 'utf8').toString('base64url');
    expect(() => decodeCommentCursor(forged)).toThrow(/no timestamp/);
  });

  it('refuses an offset masquerading as a cursor', () => {
    expect(() => decodeCommentCursor('50')).toThrow(CommentCursorInvalidError);
  });
});
