import { describe, expect, it } from 'vitest';
import { mergeRotatedSecrets, ROTATION_WINDOW_MS } from './rotation.js';

/**
 * ISS-1421 r19 — the Connections drawer's Replace key sends the new key alone. A rotation wrote the
 * secret record as the new key, the previous one and its expiry, so a Rocket.Chat rotation lost the
 * bot's userId and the connection could no longer post.
 */
const rocketchat = {
  schemas: { primaryCredentialField: 'authToken', previousCredentialField: 'previousAuthToken' },
} as never;

describe('mergeRotatedSecrets', () => {
  it('keeps every secret field the rotation did not send', () => {
    const merged = mergeRotatedSecrets(
      rocketchat,
      { authToken: 'old-token-1', userId: 'bot-user' },
      { authToken: 'new-token-2' },
    );
    expect(merged).toMatchObject({
      authToken: 'new-token-2',
      userId: 'bot-user',
      previousAuthToken: 'old-token-1',
    });
  });

  it('takes a field the rotation sent beside the key over the stored one', () => {
    const merged = mergeRotatedSecrets(
      rocketchat,
      { authToken: 'old-token-1', userId: 'bot-user' },
      { authToken: 'new-token-2', userId: 'other-bot' },
    );
    expect(merged?.userId).toBe('other-bot');
  });

  it('keeps the previous key for the rotation window', () => {
    const before = Date.now();
    const merged = mergeRotatedSecrets(
      rocketchat,
      { authToken: 'old-token-1' },
      { authToken: 'n-2' },
    );
    const expires = Date.parse(String(merged?.previousTokenExpiresAt));
    expect(expires).toBeGreaterThanOrEqual(before + ROTATION_WINDOW_MS);
  });

  it('carries no stale previous key where nothing was stored before', () => {
    const merged = mergeRotatedSecrets(rocketchat, null, { authToken: 'first-token' });
    expect(merged).toEqual({ authToken: 'first-token' });
  });

  it('is no rotation where no new key was sent', () => {
    expect(mergeRotatedSecrets(rocketchat, { authToken: 'a' }, { userId: 'b' })).toBeNull();
  });
});
