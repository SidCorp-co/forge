import { createHash, randomBytes } from 'node:crypto';

/** The sha256 hex digest a short-lived bearer token is stored and looked up by; the token itself is never stored. */
export function digestToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A fresh bearer token, `prefix` (the one the log scrubber knows) then 256 random bits, with its digest. */
export function mintPrefixedToken(prefix: string): { token: string; hash: string } {
  const token = `${prefix}${randomBytes(32).toString('base64url')}`;
  return { token, hash: digestToken(token) };
}

/** How much of a minted token a list shows, to tell one from another. */
export const SHOWN_TOKEN_CHARS = 12;
