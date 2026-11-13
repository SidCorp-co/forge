// A share token: 256 random bits, base64url, behind a prefix the log scrubber recognises. Only its
// SHA-256 is stored; the token is shown once, at creation, and never written anywhere else.

import { SHARE_TOKEN_PATTERN, SHARE_TOKEN_PREFIX } from '@forge/contracts/shares';
import { digestToken, mintPrefixedToken } from '../lib/token-digest.js';

export function mintShareToken(): { token: string; hash: string } {
  return mintPrefixedToken(SHARE_TOKEN_PREFIX);
}

export function hashShareToken(token: string): string {
  return digestToken(token);
}

export const isShareTokenShaped = (token: string): boolean => SHARE_TOKEN_PATTERN.test(token);
