/**
 * Job-scoped PATs (ISS-894 wave 0) — core mints one credential per dispatched
 * job, hands it to the runner on the `job.assigned` frame, and revokes it the
 * moment the job goes terminal. Modelled on Actions' `GITHUB_TOKEN`: the agent
 * never holds a credential that outlives the work it was given.
 *
 * The principal is `jobs.created_by`, so no new principal type exists and the
 * token can do exactly what the human who queued the job could do, on exactly
 * one project.
 */

import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { mintPat } from '../auth/pat.js';
import { jobTokenNameFor, jobTokenNameLike } from '../auth/pat-format.js';
import { db } from '../db/client.js';
import { personalAccessTokens } from '../db/schema.js';
import { logger } from '../logger.js';

// cm:guard pinned, not inherited from `RULES.patPerToken`: that default is an operator knob (`RATE_LIMIT_PAT_MAX`) sized for humans, and lowering it must not throttle the fleet. The number is measured, not padded — over 30 days of `mcp_audit_log` a single project peaked at 108 calls in one minute (p50 2, p95 6, p99 10). A job mints its token once at dispatch and has no way to ask for another, so a 429 storm does not degrade the job, it stalls it. 600 is ~6x the observed peak and still a real ceiling on a credential that is bound to one project and dies with the job.
const JOB_TOKEN_RATE_LIMIT_PER_MINUTE = 600;

/**
 * Mint the token for one dispatch. Returns the plaintext, or `null` when
 * anything went wrong — a job must still dispatch without one, falling back to
 * whatever `$FORGE_PAT` the box was provisioned with.
 */
export async function mintJobToken(job: {
  id: string;
  projectId: string;
  createdBy: string;
}): Promise<string | null> {
  try {
    // cm:guard revoke the previous one FIRST, and rename it out of the way — a retry re-dispatches the SAME job id, and `pat_user_name_uniq` is on (user_id, name), so a second mint under the live name violates the index and the whole dispatch fails. Renaming rather than deleting keeps the audit trail of what a prior attempt held.
    await db
      .update(personalAccessTokens)
      .set({
        name: sql`${personalAccessTokens.name} || '.superseded.' || extract(epoch from now())::bigint`,
        revokedAt: sql`now()`,
      })
      .where(
        and(
          eq(personalAccessTokens.name, jobTokenNameFor(job.id)),
          isNull(personalAccessTokens.revokedAt),
        ),
      );

    const { plaintext } = await mintPat({
      userId: job.createdBy,
      name: jobTokenNameFor(job.id),
      scopes: ['read', 'write'],
      boundProjectId: job.projectId,
      rateLimitMax: JOB_TOKEN_RATE_LIMIT_PER_MINUTE,
    });
    return plaintext;
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'job-token: mint failed — dispatching without one');
    return null;
  }
}

/**
 * Revoke the token for a job that has gone terminal. Idempotent, and safe to
 * call for a job that never had one.
 */
export async function revokeJobToken(jobId: string): Promise<void> {
  await db
    .update(personalAccessTokens)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(personalAccessTokens.name, jobTokenNameFor(jobId)),
        isNull(personalAccessTokens.revokedAt),
      ),
    );
}

/** Live job tokens, for the tests and ops queries that need to see them. */
export async function liveJobTokenCount(): Promise<number> {
  const rows = await db
    .select({ id: personalAccessTokens.id })
    .from(personalAccessTokens)
    .where(
      and(
        like(personalAccessTokens.name, jobTokenNameLike),
        isNull(personalAccessTokens.revokedAt),
      ),
    );
  return rows.length;
}
