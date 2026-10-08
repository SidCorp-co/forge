// A share token: 256 random bits, base64url, behind a prefix the log scrubber recognises. Only its
// SHA-256 is stored; the token is shown once, at creation, and never written anywhere else.

import { createHash, randomBytes } from 'node:crypto';
import { SHARE_TOKEN_PATTERN, SHARE_TOKEN_PREFIX } from '@forge/contracts/shares';

export function mintShareToken(): { token: string; hash: string } {
  const token = `${SHARE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashShareToken(token) };
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const isShareTokenShaped = (token: string): boolean => SHARE_TOKEN_PATTERN.test(token);
