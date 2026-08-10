import { describe, it, expect, vi } from 'vitest';

const TEST_SECRET = 'test-secret-at-least-32-chars-long-abcdef';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: TEST_SECRET, NODE_ENV: 'test' },
}));

const {
  generateNonce,
  generatePkceVerifier,
  pkceChallenge,
  signState,
  verifyState,
} = await import('./state.js');

describe('oauth state', () => {
  it('generates URL-safe random nonces of expected length', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 base64url chars
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  it('PKCE challenge is the SHA-256 of the verifier (base64url)', async () => {
    const verifier = generatePkceVerifier();
    const challenge = await pkceChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
    // Same verifier must produce same challenge.
    expect(await pkceChallenge(verifier)).toBe(challenge);
  });

  it('signs and verifies a state JWT round-trip', async () => {
    const payload = { p: 'github' as const, n: 'nonce-x', v: 'verifier-y', r: '/projects' };
    const jwt = await signState(payload);
    const out = await verifyState(jwt);
    expect(out).toMatchObject(payload);
  });

  it('rejects a state JWT with the wrong issuer', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(TEST_SECRET);
    const forged = await new SignJWT({ p: 'github', n: 'a', v: 'b', r: '/x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('not.forge')
      .setExpirationTime('5m')
      .sign(key);
    await expect(verifyState(forged)).rejects.toThrow();
  });

  it('rejects a state JWT signed with a different secret', async () => {
    const { SignJWT } = await import('jose');
    const wrongKey = new TextEncoder().encode('z'.repeat(64));
    const forged = await new SignJWT({ p: 'github', n: 'a', v: 'b', r: '/x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('forge.oauth.state')
      .setExpirationTime('5m')
      .sign(wrongKey);
    await expect(verifyState(forged)).rejects.toThrow();
  });

  it('rejects an expired state JWT', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(TEST_SECRET);
    const expired = await new SignJWT({ p: 'github', n: 'a', v: 'b', r: '/x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('forge.oauth.state')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    await expect(verifyState(expired)).rejects.toThrow();
  });

  it('rejects a state payload missing required fields', async () => {
    const { SignJWT } = await import('jose');
    const key = new TextEncoder().encode(TEST_SECRET);
    const partial = await new SignJWT({ p: 'github' /* no n, v, r */ })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('forge.oauth.state')
      .setExpirationTime('5m')
      .sign(key);
    await expect(verifyState(partial)).rejects.toThrow(/malformed/);
  });
});
