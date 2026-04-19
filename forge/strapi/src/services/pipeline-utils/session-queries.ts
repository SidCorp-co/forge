/**
 * Session query helpers: find, count, and check pipeline sessions.
 */

import {
  SESSION_UID, ISSUE_UID, MAX_SESSION_RETRIES, MAX_RESUMABLE_CONTEXT,
  DONE_ENOUGH_STATUSES, DECOMP_CHILD_READY_STATUSES,
} from './constants';

/**
 * Check if all depends_on / blocked_by relations for an issue are resolved.
 * Returns { blocked: false } if all deps are done or there are none.
 * Returns { blocked: true, pendingIds: string[] } if some deps are still in progress.
 */
export async function checkDependenciesResolved(
  strapi: any,
  issueDocumentId: string,
): Promise<{ blocked: boolean; pendingIds: string[] }> {
  const issue = await strapi.documents(ISSUE_UID).findOne({
    documentId: issueDocumentId,
    fields: ['documentId', 'id', 'relations'],
  });
  if (!issue) return { blocked: false, pendingIds: [] };

  const relations: any[] = Array.isArray(issue.relations) ? issue.relations : [];
  const blockingRelations = relations.filter(
    (r: any) => r.type === 'blocked_by' || r.type === 'depends_on',
  );
  if (blockingRelations.length === 0) return { blocked: false, pendingIds: [] };

  const blockerDocIds = blockingRelations.map((r: any) => r.targetDocumentId);
  const blockers = await strapi.documents(ISSUE_UID).findMany({
    filters: { documentId: { $in: blockerDocIds } },
    fields: ['documentId', 'id', 'status'],
    limit: blockerDocIds.length,
  });

  // Missing blockers (deleted) count as unresolved
  const returnedDocIds = new Set(blockers.map((b: any) => b.documentId));
  const missingIds = blockerDocIds.filter((docId: string) => !returnedDocIds.has(docId));

  // Decomposition parents use the narrower readiness set — a child at `developed`
  // is still mid-flight in its own review/test loop and should still block the parent.
  const isDecompParent = blockingRelations.some(
    (r: any) => r.type === 'blocked_by' && r.reason?.includes('Decomposition child')
  );
  const readySet = isDecompParent ? DECOMP_CHILD_READY_STATUSES : DONE_ENOUGH_STATUSES;
  const pendingBlockers = blockers.filter((b: any) => !readySet.has(b.status));
  const pendingIds = [
    ...pendingBlockers.map((b: any) => `ISS-${b.id}`),
    ...missingIds.map((docId: string) => `${docId.slice(0, 8)}(missing)`),
  ];

  return { blocked: pendingIds.length > 0, pendingIds };
}

/**
 * Find the most recent agent session for an issue that has a claudeSessionId.
 * Checks completed/idle first (normal resume), then failed sessions (retry).
 * Failed sessions are retried up to MAX_SESSION_RETRIES times before starting fresh.
 *
 * Skips sessions whose context has grown beyond MAX_RESUMABLE_CONTEXT — resuming
 * bloated sessions risks quality loss and "prompt too long" failures.
 *
 * When deviceId is provided, only sessions that ran on the same device are
 * considered resumable. Claude CLI session IDs are device-local, so a session
 * from a different device cannot be resumed with --resume.
 */
export async function findResumableSession(
  strapi: any,
  issueDocumentId: string,
  deviceId?: string | null,
): Promise<any | null> {
  function isResumable(session: any): boolean {
    if (!session.claudeSessionId) return false;
    // Manual flag: user marked this session as not resumable
    if (session.metadata?.noResume) return false;
    // Device check: sessions without deviceId in metadata (legacy) are skipped
    if (deviceId && session.metadata?.deviceId !== deviceId) return false;
    // Context size check: skip sessions that have grown too large
    const contextUsed = session.usage?.contextUsed || 0;
    if (contextUsed > MAX_RESUMABLE_CONTEXT) return false;
    return true;
  }

  // First: look for a healthy completed/idle session (normal pipeline resume)
  const healthy = await strapi.documents(SESSION_UID).findMany({
    filters: {
      issues: { documentId: { $eq: issueDocumentId } },
      claudeSessionId: { $notNull: true },
      status: { $in: ['completed', 'idle'] },
    },
    sort: 'updatedAt:desc',
    limit: 5,
  });
  const healthyMatch = healthy.find((s: any) => isResumable(s));
  if (healthyMatch) return healthyMatch;

  // Second: look for a failed session that can be retried
  const failed = await strapi.documents(SESSION_UID).findMany({
    filters: {
      issues: { documentId: { $eq: issueDocumentId } },
      claudeSessionId: { $notNull: true },
      status: 'failed',
      metadata: { type: { $eq: 'pipeline' } },
    },
    sort: 'updatedAt:desc',
    limit: 5,
  });
  const failedMatch = failed.find((s: any) => {
    if (!isResumable(s)) return false;
    const retryCount = s.metadata?.retryCount || 0;
    return retryCount < MAX_SESSION_RETRIES;
  });
  if (failedMatch) return failedMatch;

  return null;
}

/**
 * Count consecutive failed sessions for an issue+skill.
 * For desktop: counts fresh failures (no claudeSessionId) — resume retries are separate.
 * For antigravity: counts consecutive failures (most recent streak).
 * Used to stop the pipeline after MAX_FRESH_RETRIES attempts.
 *
 * @param currentProjectMap — if provided, only count antigravity failures whose
 *   antigravityProjectId still matches the current mapping. Failures from a
 *   deleted/replaced projectId are skipped (config was fixed, not a skill error).
 */
export async function countFailedFreshSessions(
  strapi: any,
  issueDocumentId: string,
  skill: string,
  currentProjectMap?: Record<string, string>,
): Promise<number> {
  const sessions = await strapi.documents(SESSION_UID).findMany({
    filters: {
      issues: { documentId: { $eq: issueDocumentId } },
    },
    sort: 'updatedAt:desc',
    limit: 20,
  });

  // Build a set of currently valid antigravity projectIds for quick lookup
  const validProjectIds = currentProjectMap ? new Set(Object.values(currentProjectMap)) : null;

  // Count consecutive failures for this skill (break on any success)
  let count = 0;
  for (const s of sessions) {
    if (s.metadata?.type !== 'pipeline' || s.metadata?.skill !== skill) continue;
    if (s.status === 'failed') {
      // For desktop: only count fresh sessions (no claudeSessionId)
      if (s.metadata?.runner === 'desktop' && s.claudeSessionId) continue;
      // For antigravity: skip failures from a stale/deleted projectId
      // BUT always count them if validProjectIds is empty (no mapping at all)
      // to prevent infinite retry loops when the projectId is fully invalid.
      if (validProjectIds && validProjectIds.size > 0 && s.metadata?.runner === 'antigravity' && s.metadata?.antigravityProjectId) {
        if (!validProjectIds.has(s.metadata.antigravityProjectId)) continue;
      }
      count++;
    } else if (s.status === 'completed') {
      break; // a success resets the streak
    }
  }
  return count;
}

/**
 * Check if an issue is already linked to a running pipeline session
 * for the given runner type. Prevents duplicate triggers when related
 * issues are batched together — the first issue creates the session,
 * siblings find it here and skip.
 * Only considers sessions updated within the last 10 minutes to avoid
 * stale "running" sessions from failed jobs blocking future triggers.
 */
export async function findRunningSessionForIssue(
  strapi: any,
  issueDocumentId: string,
  runner?: 'desktop' | 'antigravity',
): Promise<any | null> {
  const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  // Query running sessions, then filter by metadata in JS.
  // Strapi 5 JSON filters may not support compound conditions on the same JSON field.
  const sessions = await strapi.documents(SESSION_UID).findMany({
    filters: {
      issues: { documentId: { $eq: issueDocumentId } },
      status: 'running',
      updatedAt: { $gte: staleThreshold },
    },
    sort: 'updatedAt:desc',
    limit: 10,
  });
  return sessions.find((s: any) => {
    if (s.metadata?.type !== 'pipeline') return false;
    if (runner && s.metadata?.runner !== runner) return false;
    return true;
  }) || null;
}

/**
 * Check if any pipeline session of the given runner is running for a project.
 * Used to enforce per-project+runner sequential execution.
 * Filters by metadata in JS (Strapi 5 JSON compound filters unreliable).
 */
export async function findRunningSessionForProject(
  strapi: any,
  projectDocumentId: string,
  runner: 'desktop' | 'antigravity',
): Promise<any | null> {
  const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const sessions = await strapi.documents(SESSION_UID).findMany({
    filters: {
      project: { documentId: { $eq: projectDocumentId } },
      status: 'running',
      updatedAt: { $gte: staleThreshold },
    },
    sort: 'updatedAt:desc',
    limit: 10,
  });
  return sessions.find((s: any) =>
    s.metadata?.type === 'pipeline' && s.metadata?.runner === runner,
  ) || null;
}

/**
 * Count how many times an issue has transitioned to 'reopen' status.
 * Uses the changeHistory JSON field on the issue.
 */
export async function countReopenCycles(strapi: any, issueDocumentId: string): Promise<number> {
  try {
    const issue = await strapi.db.query('api::issue.issue').findOne({
      where: { documentId: issueDocumentId },
      select: ['changeHistory'],
    });
    const history: any[] = Array.isArray(issue?.changeHistory) ? issue.changeHistory : [];
    return history.filter((e: any) => e.field === 'status' && e.to === 'reopen').length;
  } catch {
    return 0;
  }
}

/**
 * Check if any pipeline session for a given issue is currently running.
 * Used as a race-condition guard: don't promote a queued session while
 * the previous session for the same issue is still active.
 */
export async function hasRunningSessionForIssue(
  strapi: any,
  issueDocumentId: string,
  excludeSessionId?: string,
): Promise<boolean> {
  const running = await strapi.documents(SESSION_UID).findMany({
    filters: {
      issues: { documentId: { $eq: issueDocumentId } },
      status: 'running',
    },
    limit: 5,
  });
  return running.some((s: any) => s.documentId !== excludeSessionId);
}
