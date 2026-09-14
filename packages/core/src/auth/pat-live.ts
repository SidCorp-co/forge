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
// cm:guard ONE spelling of "live", and `auth/pat.ts:verifyPat` is built from it rather than carrying its own copy. The two halves are not the same question: a token whose `expires_at` has passed is never revoked, so a reader testing only `revoked_at IS NULL` counts it as live and tells an operator an account can act when the door would turn it away. Every surface that reports whether a principal can act asks here — `orgs/agent-accounts.ts:listAgentAccounts` and the reachability of a conversation handle (ISS-1003 criteria 2, 7, 20).
export function patIsLive() {
  return and(
    isNull(personalAccessTokens.revokedAt),
    or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, sql`now()`)),
  );
}
