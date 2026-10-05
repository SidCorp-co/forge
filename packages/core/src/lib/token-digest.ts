import { createHash } from 'node:crypto';

/** The sha256 hex digest a short-lived bearer token is stored and looked up by; the token itself is never stored. */
export function digestToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}
