import { and, gt, isNull, or, sql } from 'drizzle-orm';
import { personalAccessTokens } from '../db/schema.js';

/**
 * Unrevoked, unexpired, and not issued to a box that is revoked: a revoked box's token stops
 * answering even where its own revocation never landed (a prune before ISS-219 left them live).
 */
export function patIsLive() {
  return and(
    isNull(personalAccessTokens.revokedAt),
    or(isNull(personalAccessTokens.expiresAt), gt(personalAccessTokens.expiresAt, sql`now()`)),
    sql`NOT EXISTS (SELECT 1 FROM devices revoked_box
      WHERE revoked_box.id = ${personalAccessTokens.deviceId} AND revoked_box.status = 'revoked')`,
  );
}
