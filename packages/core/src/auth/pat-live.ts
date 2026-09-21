import { and, gt, isNull, or, sql } from 'drizzle-orm';
import { personalAccessTokens } from '../db/schema.js';

/**
 * Unrevoked AND unexpired.
 */
export function patIsLive() {
  return and(
    isNull(personalAccessTokens.revokedAt),
    or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, sql`now()`)),
  );
}
