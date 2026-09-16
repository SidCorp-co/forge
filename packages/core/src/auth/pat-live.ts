/**
 * What makes a row in `personal_access_tokens` a credential that would still
 * be accepted (ISS-1003).
 *
 * Its own module rather than a function in `auth/pat.ts`, because that file
 * loads `config/env.js` at import time to read `PAT_PEPPER`: any reader that
 * only wants to ask "can this principal act" would pull the whole environment
 * in with it, and a unit suite importing such a reader dies at collection with
 * "Invalid environment" rather than running.
 */

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
