// An issue whose code is already on the base branch but which is still parked
// at `waiting` is asserting two contradictory things at once: the work shipped,
// and the work is not done. That contradiction is the signal — nothing else
// distinguishes "parked on purpose, nothing at stake" from "parked on a question
// nobody was told about" (ISS-762).
//
// Detection + notify only. This pass never moves an issue: `waiting` is a
// deliberate human park and only a human may leave it. The whole point is to
// tell that human a decision is owed.

import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, notifications, projects } from '../db/schema.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { projectAdminUserIds } from '../notifications/project-admins.js';

/**
 * How long an issue may sit `waiting` with merged code before it is stranded.
 *
 * A legitimate merge → verify → close pass takes minutes, so this is not a race
 * with the happy path. It is deliberately far below the daily sweep that found
 * the first case at 29h, and far below the 7–12 days the three known cases
 * actually sat.
 */
export const STRANDED_GRACE_MS = 6 * 60 * 60 * 1000;

export interface StrandedIssuesResult {
  /** Issues matching the stranded predicate this tick. */
  detected: number;
  /** Notifications actually inserted (0 when every one was already surfaced). */
  notified: number;
}

export function strandedResolutionKey(issueId: string): string {
  return `issue:${issueId}:stranded`;
}

/**
 * Surface every issue parked at `waiting` whose code already reached the base
 * branch. Best-effort: never throws — a failure here must not abort the sweep.
 */
export async function detectStrandedIssues(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<StrandedIssuesResult> {
  try {
    const cutoff = new Date(now.getTime() - STRANDED_GRACE_MS);

    const rows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        issSeq: issues.issSeq,
        title: issues.title,
        mergedAt: issues.mergedAt,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.status, 'waiting'),
          isNotNull(issues.mergedAt),
          lt(issues.mergedAt, cutoff),
          ...(scope.projectId ? [eq(issues.projectId, scope.projectId)] : []),
        ),
      );

    let notified = 0;
    for (const row of rows) {
      const resolutionKey = strandedResolutionKey(row.id);

      // cm:guard dedupe on the UNREAD row, not on existence — the sweep runs every tick, and without this each stranded issue would re-notify forever. Reading the notification is the human saying "seen"; a re-strand after that legitimately pings again.
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.type, 'issue_stranded'),
            eq(notifications.read, false),
            eq(notifications.resolutionKey, resolutionKey),
          ),
        )
        .limit(1);
      if (existing) continue;

      const ref = row.issSeq !== null ? `ISS-${row.issSeq}` : 'An issue';
      const days = Math.floor((now.getTime() - (row.mergedAt?.getTime() ?? 0)) / 86_400_000);
      const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'hours';

      const adminIds = await projectAdminUserIds(row.projectId);
      for (const userId of adminIds) {
        await emitNotification({
          userId,
          projectId: row.projectId,
          issueId: row.id,
          type: 'issue_stranded',
          title: `${ref} is waiting on you — ${row.projectName}`,
          body: `Its code merged ${age} ago but the issue is still parked, so nothing will move it forward until you decide. Open it and read the last comment: a step that could not finish its checks leaves the decision here.`,
          resolutionKey,
        });
        notified += 1;
      }
    }

    if (rows.length > 0) {
      logger.warn(
        { detected: rows.length, notified, issueIds: rows.map((r) => r.id) },
        'stranded-issues: parked with merged code',
      );
    }

    return { detected: rows.length, notified };
  } catch (err) {
    logger.error({ err }, 'stranded-issues: detection failed');
    return { detected: 0, notified: 0 };
  }
}

/** Rows matching the stranded predicate, for the ops/health surface. */
export async function countStrandedIssues(projectId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.status, 'waiting'),
        isNotNull(issues.mergedAt),
        eq(issues.projectId, projectId),
      ),
    );
  return Number(row?.n ?? 0);
}
