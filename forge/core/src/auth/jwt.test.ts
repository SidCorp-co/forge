import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const { signUserToken, verifyUserToken, USER_JWT_TTL_SECONDS } = await import('./jwt.js');

describe('jwt', () => {
  it('signs and verifies a token, round-tripping the userId into sub', async () => {
    const token = await signUserToken('user-123');
    const claims = await verifyUserToken(token);
    expect(claims.sub).toBe('user-123');
    expect(claims.typ).toBe('user');
  });

  it('sets exp ~7d in the future (±60s tolerance)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await signUserToken('user-1');
    const claims = await verifyUserToken(token);
    const expectedExp = before + USER_JWT_TTL_SECONDS;
    expect(claims.exp).toBeDefined();
    expect(Math.abs((claims.exp as number) - expectedExp)).toBeLessThanOrEqual(60);
  });

  it('rejects a token signed with a different secret', async () => {
    const wrongSecret = new TextEncoder().encode('different-secret-at-least-32-chars-long');
    const forged = await new SignJWT({ typ: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-evil')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrongSecret);
    await expect(verifyUserToken(forged)).rejects.toThrow();
  });

  it('rejects a token with wrong typ claim (device instead of user)', async () => {
    const key = new TextEncoder().encode(TEST_SECRET);
    const deviceToken = await new SignJWT({ typ: 'device' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('device-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    await expect(verifyUserToken(deviceToken)).rejects.toThrow('invalid token type');
  });
});
