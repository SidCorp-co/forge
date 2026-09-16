// An issue nobody is coming for, in the two shapes it takes, surfaced under
// one notification because a reader owes both the same act.
//
// `waiting` is the park shape: a human decision nobody was told about.
// `merged_at` set under a live status is the SHIPPED shape: the code landed
// and the close it owed was never written because the run that owed it died
// (ISS-940, measured on ISS-920 and ISS-931). The second reads as claimable
// work, so the reconciler is barred from re-dispatching it and this pass is
// what breaks the silence instead.
//
// Detection + notify only. Neither pass moves an issue: a park is a human's
// decision, and a close is a claim about shipped work that a pass which
// cannot read the repository must not make.

import { and, eq, gte, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStatuses, issues, notifications, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { projectAdminUserIds } from '../notifications/project-admins.js';
import { isTerminalPlacement } from './status-assertions.js';

/**
 * How long an issue may sit `waiting` with merged code before it is stranded.
 *
 * A legitimate merge → verify → close pass takes minutes, so this is not a race
 * with the happy path. It is deliberately far below the daily sweep that found
 * the first case at 29h, and far below the 7–12 days the three known cases
 * actually sat.
 */
export const STRANDED_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * How long a surfaced park stays surfaced before it may ping again.
 *
 * The dedupe below keys on an UNREAD notification, so reading one re-arms it —
 * intended, because a park still unresolved a day later is still owed a
 * decision. What makes that safe is this window: the sweep runs every 60s, so
 * without it "read" means "pinged again within the minute", every minute, for
 * the life of the park.
 */
export const STRANDED_RENOTIFY_MS = 24 * 60 * 60 * 1000;

export interface StrandedIssuesResult {
  /** Issues matching the stranded predicate this tick. */
  detected: number;
  /** Notifications actually inserted (0 when every one was already surfaced). */
  notified: number;
}

export function strandedResolutionKey(issueId: string): string {
  return `issue:${issueId}:stranded`;
}

export function owedCloseResolutionKey(issueId: string): string {
  return `issue:${issueId}:owed-close`;
}

/**
 * Insert one `issue_stranded` notification per project admin, unless this
 * strand is already surfaced. Returns how many were written, and `-1` when the
 * project has no admin at all — nobody was reachable, which is the one case a
 * `notified` count of zero cannot distinguish from "nothing to say".
 */
async function surfaceOnce(args: {
  now: Date;
  projectId: string;
  issueId: string;
  resolutionKey: string;
  title: string;
  body: string;
}): Promise<number> {
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, 'issue_stranded'),
        eq(notifications.resolutionKey, args.resolutionKey),
        isNull(notifications.resolvedAt),
        or(
          eq(notifications.read, false),
          gte(notifications.createdAt, new Date(args.now.getTime() - STRANDED_RENOTIFY_MS)),
        ),
      ),
    )
    .limit(1);
  if (existing) return 0;

  const adminIds = await projectAdminUserIds(args.projectId);
  if (adminIds.length === 0) return -1;
  for (const userId of adminIds) {
    await emitNotification({
      userId,
      projectId: args.projectId,
      issueId: args.issueId,
      type: 'issue_stranded',
      title: args.title,
      body: args.body,
      resolutionKey: args.resolutionKey,
    });
  }
  return adminIds.length;
}

/**
 * Surface every `waiting` park that is past {@link STRANDED_GRACE_MS} and has
 * nothing coming for it. Best-effort: never throws — a failure here must not
 * abort the sweep.
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
        issuePrefix: projects.issuePrefix,
        issSeq: issues.issSeq,
        title: issues.title,
        mergedAt: issues.mergedAt,
        updatedAt: issues.updatedAt,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.status, 'waiting'),
          lt(issues.updatedAt, cutoff),
          ...(scope.projectId ? [eq(issues.projectId, scope.projectId)] : []),
        ),
      );

    let notified = 0;
    let unreachable = 0;
    for (const row of rows) {
      const ref = row.issSeq !== null ? formatIssueRef(row.issuePrefix, row.issSeq) : 'An issue';
      const since = row.mergedAt ?? row.updatedAt;
      const days = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
      const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'hours';
      const lead = row.mergedAt
        ? `Its code merged ${age} ago but the issue is still parked`
        : `It has been parked ${age}`;

      const sent = await surfaceOnce({
        now,
        projectId: row.projectId,
        issueId: row.id,
        resolutionKey: strandedResolutionKey(row.id),
        title: `${ref} is waiting on you — ${row.projectName}`,
        body: `${lead}, so nothing will move it forward until you decide. Open it and read the last comment: a step that could not finish its checks leaves the decision here.`,
      });
      if (sent < 0) unreachable += 1;
      else notified += sent;
    }

    if (notified > 0 || unreachable > 0) {
      logger.warn(
        { detected: rows.length, notified, unreachable, issueIds: rows.map((r) => r.id) },
        'stranded-issues: a waiting park with nothing coming for it',
      );
    }

    return { detected: rows.length, notified };
  } catch (err) {
    logger.error({ err }, 'stranded-issues: detection failed');
    return { detected: 0, notified: 0 };
  }
}

/**
 * Surface every issue whose code landed and whose close was never written.
 *
 * `merged_at` is the raw evidence field (`status-assertions.ts`) — set by the
 * hop out of the project's base merge state, or by a close that already
 * happened. Under a live status with no job and no run, it says the work
 * shipped and the actor that owed the close is gone.
 *
 * Detection + notify only, like the park above: closing is a claim about
 * shipped work, and a pass that cannot read the repo must not make it.
 */
export async function detectOwedCloses(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<StrandedIssuesResult> {
  try {
    const cutoff = new Date(now.getTime() - STRANDED_GRACE_MS);
    const terminal = issueStatuses.filter(isTerminalPlacement);

    const rows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        issuePrefix: projects.issuePrefix,
        issSeq: issues.issSeq,
        status: issues.status,
        mergedAt: issues.mergedAt,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          isNotNull(issues.mergedAt),
          lt(issues.mergedAt, cutoff),
          notInArray(issues.status, terminal),
          sql`not exists (select 1 from jobs j where j.issue_id = issues.id and j.status in ('queued','dispatched','running'))`,
          sql`not exists (select 1 from pipeline_runs r where r.issue_id = issues.id and r.status = 'running')`,
          ...(scope.projectId ? [eq(issues.projectId, scope.projectId)] : []),
        ),
      );

    let notified = 0;
    let unreachable = 0;
    for (const row of rows) {
      const ref = row.issSeq !== null ? formatIssueRef(row.issuePrefix, row.issSeq) : 'An issue';
      const days = Math.floor((now.getTime() - (row.mergedAt?.getTime() ?? 0)) / 86_400_000);
      const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'hours';
      const sent = await surfaceOnce({
        now,
        projectId: row.projectId,
        issueId: row.id,
        resolutionKey: owedCloseResolutionKey(row.id),
        title: `${ref} shipped but never closed — ${row.projectName}`,
        body: `Its code has carried a merge mark for ${age} while the issue still reads \`${row.status}\`, and nothing is running on it. The step that owed the close did not write it. Read the branch, then close it — or clear the mark with \`unmark\` if it never landed.`,
      });
      if (sent < 0) unreachable += 1;
      else notified += sent;
    }

    if (notified > 0 || unreachable > 0) {
      logger.warn(
        { detected: rows.length, notified, unreachable, issueIds: rows.map((r) => r.id) },
        'stranded-issues: merged code under a live status with nothing running',
      );
    }

    return { detected: rows.length, notified };
  } catch (err) {
    logger.error({ err }, 'stranded-issues: owed-close detection failed');
    return { detected: 0, notified: 0 };
  }
}
