/**
 * PR-5c — runner-reported resume failure handling.
 *
 * The Tauri runner tags resume failures with `[RESUME_FAILED]` (see
 * `spawn.rs` in packages/dev) when claude exits with stderr matching
 * "session not found" / "could not resume" / "--resume" patterns.
 *
 * Orchestrator behavior, decided by `pipelineConfig.onResumeFail`:
 *   - "fresh" (default) — null out the prior session's claudeSessionId in
 *     the matching (issue, group) so the auto-retry path's
 *     `findPriorSessionInGroup` returns nothing. The retry then dispatches
 *     as a fresh CLI session.
 *   - "abort" — caller should NOT schedule retry; the lifecycle route
 *     converts to a permanent failure (`failure_reason='resume_failed'`).
 *
 * Returns the resolved policy so the lifecycle route can branch.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, projects } from '../db/schema.js';
import { logger } from '../logger.js';

const RESUME_TAG = '[RESUME_FAILED]';

export function isResumeFailedError(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.startsWith(RESUME_TAG);
}

export type OnResumeFailPolicy = 'fresh' | 'abort';

async function loadOnResumeFailPolicy(projectId: string): Promise<OnResumeFailPolicy> {
  try {
    const [row] = await db
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac = (row?.agentConfig ?? {}) as Record<string, unknown>;
    const pc = (ac.pipelineConfig ?? {}) as Record<string, unknown>;
    const policy = pc.onResumeFail;
    return policy === 'abort' ? 'abort' : 'fresh';
  } catch {
    return 'fresh';
  }
}

/**
 * Invalidate prior session(s) in the same (issue, group) so the next dispatch
 * can't resume them. Sets claudeSessionId to NULL on every matching row.
 * Idempotent; bounded (sessions per (issue,group) typically single digits).
 */
async function invalidatePriorSessions(args: {
  issueId: string;
  sessionGroup: string;
}): Promise<number> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id FROM agent_sessions
    WHERE metadata->>'issueId' = ${args.issueId}
      AND metadata->>'sessionGroup' = ${args.sessionGroup}
      AND claude_session_id IS NOT NULL
  `);
  let invalidated = 0;
  for (const row of rows) {
    await db
      .update(agentSessions)
      .set({ claudeSessionId: null })
      .where(eq(agentSessions.id, row.id));
    invalidated += 1;
  }
  return invalidated;
}

/**
 * Called from the job-lifecycle route whenever a failed job carries the
 * `[RESUME_FAILED]` tag. Decides + applies the configured policy and
 * returns it so the caller can either schedule a retry (fresh) or convert
 * to a permanent failure (abort).
 */
export async function handleResumeFailed(job: {
  id: string;
  projectId: string;
  issueId: string | null;
  payload: unknown;
}): Promise<OnResumeFailPolicy> {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const sessionGroup =
    typeof payload.sessionGroup === 'string' && payload.sessionGroup.length > 0
      ? payload.sessionGroup
      : null;

  if (!sessionGroup || !job.issueId) {
    // Resume-failed tag arrived but the job doesn't belong to a session
    // group — nothing to invalidate. Treat as fresh.
    return 'fresh';
  }

  const policy = await loadOnResumeFailPolicy(job.projectId);

  // Both policies invalidate prior sessions — under "abort" so a future
  // operator-triggered retry doesn't repeat the failure with the same
  // stale claudeSessionId.
  try {
    const n = await invalidatePriorSessions({
      issueId: job.issueId,
      sessionGroup,
    });
    logger.info(
      { jobId: job.id, issueId: job.issueId, sessionGroup, invalidated: n, policy },
      'resume-failed: invalidated prior sessions',
    );
  } catch (err) {
    logger.warn(
      { err, jobId: job.id, issueId: job.issueId, sessionGroup },
      'resume-failed: invalidate failed',
    );
  }

  return policy;
}
