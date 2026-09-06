/**
 * Session-scoped PATs (ISS-927) — core mints one credential per unattended
 * agent session, hands it to the runner on the `agent:start` frame, and revokes
 * it the moment the session goes terminal.
 *
 * The sibling of `jobs/job-token.ts`, and deliberately its twin rather than its
 * generalisation: the two differ in the row they key on, the writer that revokes
 * them and the frame that delivers them, and a merged module would have to carry
 * all three differences as parameters to save one `mintPat` call.
 *
 * This is the credential the 8 cron schedules never had. They dispatch through
 * `agent:start` on the device room, so there is no `jobs` row to mint against —
 * measured on ISS-894, that class held a device token permanently, which is why
 * the device token could not be retired from the data plane before this existed.
 *
 * The principal is `agent_sessions.user_id`, so no new principal type exists and
 * the token can do exactly what the human whose session it is could do, on
 * exactly one project.
 */

import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { mintPat } from '../auth/pat.js';
import { sessionTokenNameFor } from '../auth/pat-format.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { logger } from '../logger.js';

// cm:guard the same pinned 600/min as `jobs/job-token.ts`, and pinned for the same reason: `RULES.patPerToken` is an operator knob (`RATE_LIMIT_PAT_MAX`) sized for humans, and lowering it must not throttle the fleet. The number is the one ISS-894 measured — a single project peaked at 108 calls in one minute (p50 2, p95 6, p99 10) — not a fresh guess. A session mints its token once at cold start and has no way to ask for another, so a 429 storm does not degrade the session, it stalls it.
const SESSION_TOKEN_RATE_LIMIT_PER_MINUTE = 600;

/**
 * Mint the token for one cold start. Returns the plaintext, or `null` when
 * anything went wrong — a session must still dispatch without one, falling back
 * to whatever `$FORGE_PAT` the box was provisioned with.
 */
export async function mintSessionToken(session: {
  id: string;
  projectId: string;
  userId: string;
}): Promise<string | null> {
  try {
    // cm:guard revoke the previous one FIRST, and rename it out of the way — a migration or a re-pin cold-starts the SAME session id, and `pat_user_name_uniq` is on (user_id, name), so a second mint under the live name violates the index and the whole dispatch fails. Renaming rather than deleting keeps the audit trail of what a prior attempt held.
    await db
      .update(personalAccessTokens)
      .set({
        name: sql`${personalAccessTokens.name} || '.superseded.' || extract(epoch from now())::bigint`,
        revokedAt: sql`now()`,
      })
      .where(
        and(
          eq(personalAccessTokens.name, sessionTokenNameFor(session.id)),
          isNull(personalAccessTokens.revokedAt),
        ),
      );

    const { plaintext } = await mintPat({
      userId: session.userId,
      name: sessionTokenNameFor(session.id),
      scopes: ['read', 'write'],
      boundProjectId: session.projectId,
      rateLimitMax: SESSION_TOKEN_RATE_LIMIT_PER_MINUTE,
    });
    return plaintext;
  } catch (err) {
    logger.error(
      { err, sessionId: session.id },
      'session-token: mint failed — dispatching without one',
    );
    return null;
  }
}

/**
 * Revoke the token for a session that has gone terminal. Idempotent, and safe
 * to call for a session that never had one.
 */
// cm:edge lockstep -> packages/core/src/agent-sessions/routes.ts — the revoke must fire from BOTH terminal writers. `lifecycle/transition.ts` is the chokepoint for cancel/sweeper/dispatch-failure, but the runner's happy-path completion is a direct `db.update` in `PATCH /:id` that the chokepoint never sees and the `lifecycle.transition` guard test cannot detect (it scans for a status LITERAL and that handler writes a variable). Wiring only the chokepoint leaves a live write-scoped credential behind every session that finishes normally — the ISS-675 escalation bridge had to be wired into both for exactly this reason.
export async function revokeSessionToken(sessionId: string): Promise<void> {
  await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(personalAccessTokens.name, sessionTokenNameFor(sessionId)),
        isNull(personalAccessTokens.revokedAt),
      ),
    );
}

/**
 * True for a session opened by a machine with nobody at the keyboard —
 * `runKind: 'system'`, stamped at creation by `createChatSessionRow`.
 *
 * This, and not "is it a chat session", is what decides whether a session gets
 * its own credential: only an unattended session is single-turn, and only a
 * single-turn session can have its token revoked at the first terminal write
 * without cutting a live process off from `$FORGE_PAT`.
 */
export function isUnattendedSession(metadata: unknown): boolean {
  return (metadata as { unattended?: unknown } | null)?.unattended === true;
}

/** Live session tokens, for the tests and ops queries that need to see them. */
export async function liveSessionTokenCount(): Promise<number> {
  const rows = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        like(personalAccessTokens.name, `${sessionTokenNameFor('')}%`),
        isNull(personalAccessTokens.revokedAt),
      ),
    );
  return rows.length;
}
