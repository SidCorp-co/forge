/**
 * The pure rules of a feedback server key (ISS-922): its secret's shape and digest, whether it still
 * admits a filing, and the expiry a mint may set. `server-keys.ts` holds the reads and writes.
 */

import { randomBytes } from 'node:crypto';
import {
  FEEDBACK_SERVER_KEY_PATTERN,
  FEEDBACK_SERVER_KEY_PREFIX,
  FEEDBACK_SERVER_KEY_SHOWN_CHARS,
} from '@forge/contracts/feedback-server-keys';
import type { Refusal } from '../lib/refusal.js';
import { digestToken } from '../lib/token-digest.js';

/** A fresh secret and the SHA-256 it is kept as. */
export function mintServerKeySecret(): { secret: string; hash: string; prefix: string } {
  const secret = `${FEEDBACK_SERVER_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    hash: digestToken(secret),
    prefix: secret.slice(0, FEEDBACK_SERVER_KEY_SHOWN_CHARS),
  };
}

/** The SHA-256 a presented secret is looked up by, or null for text that is not one. */
export function serverKeyHashOf(token: string): string | null {
  return FEEDBACK_SERVER_KEY_PATTERN.test(token) ? digestToken(token) : null;
}

/** Why a key no longer admits a filing at `now`, or null while it does. */
export function serverKeyClosed(
  key: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date,
): 'revoked' | 'expired' | null {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return 'expired';
  return null;
}

/** An expiry a mint may set: none, or one still ahead. */
export function expiryRefusal(expiresAt: Date | null, now: Date): Refusal | null {
  if (!expiresAt || expiresAt.getTime() > now.getTime()) return null;
  return {
    code: 'FEEDBACK_SERVER_KEY_EXPIRY_PAST',
    path: '/expiresAt',
    detail: `a key cannot be minted already expired: ${expiresAt.toISOString()} is not after now; send a later expiresAt, or none`,
  };
}
