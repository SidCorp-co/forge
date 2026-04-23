import { describe, expect, it } from 'vitest';
import {
  REFRESH_TOKEN_PREFIX_LEN,
  REFRESH_TOKEN_TTL_SECONDS,
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  refreshTokenPrefix,
  verifyRefreshToken,
} from './refresh-token.js';

describe('refresh-token helpers', () => {
  it('REFRESH_TOKEN_TTL_SECONDS is 30 days', () => {
    expect(REFRESH_TOKEN_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('generateRefreshToken returns base64url raw and matching prefix', () => {
    const { raw, prefix } = generateRefreshToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw.length).toBeGreaterThanOrEqual(40);
    expect(prefix).toHaveLength(REFRESH_TOKEN_PREFIX_LEN);
    expect(raw.startsWith(prefix)).toBe(true);
  });

  it('generateRefreshToken is non-deterministic', () => {
    const a = generateRefreshToken().raw;
    const b = generateRefreshToken().raw;
    expect(a).not.toBe(b);
  });

  it('refreshTokenPrefix returns first N chars', () => {
    expect(refreshTokenPrefix('abcdefghijkl')).toBe('abcdefgh');
  });

  it('hash + verify round-trip succeeds for the same token', async () => {
    const { raw } = generateRefreshToken();
    const hash = await hashRefreshToken(raw);
    expect(await verifyRefreshToken(hash, raw)).toBe(true);
  });

  it('verify returns false for a different token', async () => {
    const a = generateRefreshToken().raw;
    const b = generateRefreshToken().raw;
    const hash = await hashRefreshToken(a);
    expect(await verifyRefreshToken(hash, b)).toBe(false);
  });

  it('verify returns false for a malformed hash (no throw)', async () => {
    expect(await verifyRefreshToken('not-a-valid-hash', 'anything')).toBe(false);
  });

  it('refreshTokenExpiresAt is TTL seconds in the future', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const exp = refreshTokenExpiresAt(now);
    expect(exp.getTime() - now.getTime()).toBe(REFRESH_TOKEN_TTL_SECONDS * 1000);
  });
});
