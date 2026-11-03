// The pure rules of a feedback server key (ISS-922): a minted secret matches the shape the door
// recognises and is kept only as its digest; a key admits until it is revoked or reaches its expiry;
// a mint may not set an expiry already past.
// @direct-test-of packages/core/src/feedback/server-key-rules.ts
// @direct-test-of packages/contracts/src/feedback-server-keys.ts

import {
  FEEDBACK_SERVER_KEY_PATTERN,
  isFeedbackServerKeyLike,
} from '@forge/contracts/feedback-server-keys';
import { describe, expect, it } from 'vitest';
import {
  expiryRefusal,
  mintServerKeySecret,
  serverKeyClosed,
  serverKeyHashOf,
} from './server-key-rules.js';

const now = new Date('2026-11-03T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

describe('a minted server key secret', () => {
  it('matches the shape, carries its prefix, and digests to what is stored', () => {
    const { secret, hash, prefix } = mintServerKeySecret();
    expect(secret).toMatch(FEEDBACK_SERVER_KEY_PATTERN);
    expect(isFeedbackServerKeyLike(secret)).toBe(true);
    expect(secret.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(secret.length);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(serverKeyHashOf(secret)).toBe(hash);
  });

  it('is unique per mint', () => {
    expect(mintServerKeySecret().secret).not.toBe(mintServerKeySecret().secret);
  });

  it.each([
    ['a PAT', `forge_pat_dev_${'a'.repeat(64)}`],
    ['a short fsk', 'fsk_short'],
    ['an fsk with a bad character', `fsk_${'a'.repeat(42)}!`],
    ['an empty string', ''],
  ])('looks up nothing for %s', (_what, text) => {
    expect(serverKeyHashOf(text)).toBeNull();
  });

  it('is told apart from a PAT and a session by its prefix alone', () => {
    expect(isFeedbackServerKeyLike('fsk_anything')).toBe(true);
    expect(isFeedbackServerKeyLike(`forge_pat_dev_${'a'.repeat(64)}`)).toBe(false);
    expect(isFeedbackServerKeyLike('eyJhbGciOi.x.y')).toBe(false);
  });
});

describe('whether a key still admits a filing', () => {
  it('admits with no expiry and no revoke', () => {
    expect(serverKeyClosed({ revokedAt: null, expiresAt: null }, now)).toBeNull();
  });
  it('admits before its expiry', () => {
    expect(serverKeyClosed({ revokedAt: null, expiresAt: at(1) }, now)).toBeNull();
  });
  it('is expired at the instant of its expiry and after', () => {
    expect(serverKeyClosed({ revokedAt: null, expiresAt: now }, now)).toBe('expired');
    expect(serverKeyClosed({ revokedAt: null, expiresAt: at(-1) }, now)).toBe('expired');
  });
  it('is revoked whatever its expiry says', () => {
    expect(serverKeyClosed({ revokedAt: at(-5), expiresAt: at(60_000) }, now)).toBe('revoked');
    expect(serverKeyClosed({ revokedAt: at(-5), expiresAt: at(-1) }, now)).toBe('revoked');
  });
});

describe('the expiry a mint may set', () => {
  it('takes none, or one ahead of now', () => {
    expect(expiryRefusal(null, now)).toBeNull();
    expect(expiryRefusal(at(1), now)).toBeNull();
  });
  it('refuses one at or before now by name, at its field', () => {
    for (const past of [now, at(-1), new Date('2020-01-01T00:00:00Z')]) {
      expect(expiryRefusal(past, now)).toMatchObject({
        code: 'FEEDBACK_SERVER_KEY_EXPIRY_PAST',
        path: '/expiresAt',
      });
    }
  });
});
