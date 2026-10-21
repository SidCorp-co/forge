import { describe, expect, it } from 'vitest';
import { mergeRotatedSecrets, newKeyRefused, ROTATION_WINDOW_MS } from './rotation.js';

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

/**
 * ISS-1421 r20 — judge-82 found Postman's and Epodsystem's replaced key kept and tried by Test
 * connection, so a wrong new key passed the check and failed a day later. A provider whose previous
 * key nothing reads keeps none, and a stale one is not carried into the new record.
 */
describe('a provider that keeps no previous key', () => {
  const postman = {
    schemas: { primaryCredentialField: 'apiKey', previousCredentialField: null },
  } as never;

  it('stores the new key alone, with no previous key', () => {
    const merged = mergeRotatedSecrets(postman, { apiKey: 'old-key-1' }, { apiKey: 'new-key-2' });
    expect(merged).toEqual({ apiKey: 'new-key-2' });
  });

  it('drops a previous key and its expiry stored before', () => {
    const merged = mergeRotatedSecrets(
      postman,
      { apiKey: 'old', previousApiKey: 'older', previousTokenExpiresAt: '2026-10-22T00:00:00Z' },
      { apiKey: 'new' },
    );
    expect(merged).toEqual({ apiKey: 'new' });
  });
});

describe('newKeyRefused', () => {
  it("says who refused the new key and until when Forge's own calls use the previous one", () => {
    const refused = newKeyRefused('Sentry', { previousTokenExpiresAt: '2026-10-22T14:53:00.000Z' });
    expect(refused.status).toBe('needs_reauth');
    expect(refused.message).toBe(
      'Sentry refused the new key. Forge is still using the previous key until 22 October 2026, 14:53 UTC.',
    );
    expect(refused.diagnostics).toEqual({
      newKeyRefused: true,
      previousKeyUntil: '2026-10-22T14:53:00.000Z',
    });
  });
});
