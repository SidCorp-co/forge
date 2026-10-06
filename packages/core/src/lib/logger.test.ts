import { describe, expect, it } from 'vitest';
import { serializeLogErr } from './logger.js';

describe("a log record's err field", () => {
  it('keeps a message string as one string, never one key per character', () => {
    expect(serializeLogErr('the body is invalid')).toBe('the body is invalid');
  });

  it('scrubs a secret out of a message string', () => {
    const logged = serializeLogErr(
      'refused: Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(typeof logged).toBe('string');
    expect(logged).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it("logs an Error in pino's error shape", () => {
    expect(serializeLogErr(new TypeError('no such row'))).toMatchObject({
      type: 'TypeError',
      message: 'no such row',
    });
  });
});
