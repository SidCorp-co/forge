import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { ASSERTS_WORK_IN_PROGRESS } from '../issues/status-sets.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { projectAdminUserIds } from '../notifications/project-admins.js';
import { sweepGroupKey } from './stranded-issues.js';

/**
 * How long an issue may assert work with no run behind it before it is named.
 *
 * A live dispatch writes the issue's status and opens its run session in two
 * separate calls, and the box makes them in that order, so there is a real
 * window in which this predicate is true of perfectly healthy work. The window
 * is a second or two; this is minutes, so what it excludes is the race and not
 * the condition.
 */
export const ORPHAN_ASSERTION_GRACE_MS = 10 * 60 * 1000;

/**
 * How long a named orphan stays named before it may be named again.
 */
export const ORPHAN_RENOTIFY_MS = 24 * 60 * 60 * 1000;

export interface IssueRunInvariantResult {
  /** Issues matching the predicate this tick. */
  detected: number;
  /** Episodes named this tick (0 when every one was already named). */
  reported: number;
}

/**
 * The notification type this reports under.
 */
export function orphanedAssertionResolutionKey(issueId: string): string {
  return `issue:${issueId}:run-assertion-orphaned`;
}

interface OrphanRow {
  issueId: string;
  projectId: string;
  issSeq: number;
  issuePrefix: string | null;
  status: string;
  title: string;
  /** When the issue last asserted, as the driver hands it back. */
  since: string;
}

async function orphanedAssertions(now: Date): Promise<OrphanRow[]> {
  const cutoff = new Date(now.getTime() - ORPHAN_ASSERTION_GRACE_MS).toISOString();
  return (await db.execute(sql`
    SELECT i.id            AS "issueId",
           i.project_id    AS "projectId",
           i.iss_seq       AS "issSeq",
           p.issue_prefix  AS "issuePrefix",
           i.status        AS "status",
           i.title         AS "title",
           i.updated_at    AS "since"
      FROM issues i
      JOIN projects p ON p.id = i.project_id
     WHERE i.status IN (${sql.join(
       ASSERTS_WORK_IN_PROGRESS.map((s) => sql`${s}`),
       sql`, `,
     )})
       AND i.updated_at < ${cutoff}
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
          WHERE j.issue_id = i.id AND j.status NOT IN ('done', 'failed', 'cancelled')
       )
       AND NOT EXISTS (
         SELECT 1 FROM pipeline_runs pr
          WHERE pr.issue_id = i.id AND pr.status IN ('running', 'paused')
       )
       AND NOT EXISTS (
         SELECT 1 FROM pipeline_runs rs
          WHERE rs.project_id = i.project_id
            AND rs.kind = 'system'
            AND rs.status IN ('running', 'paused')
            -- prefix: matching on issue_prefix here makes a live run's issues invisible to
            -- this pass and every one of them is reported as an orphan (ISS-992)
            AND rs.metadata -> 'runIssues' @> to_jsonb('ISS-' || i.iss_seq) -- ISS-992:canonical
       )
  `)) as unknown as OrphanRow[];
}

/**
 * Name one orphan episode, unless this episode is already named.
 */
async function nameOnce(args: { now: Date; row: OrphanRow; ref: string }): Promise<boolean> {
  const resolutionKey = orphanedAssertionResolutionKey(args.row.issueId);
  const [existing] = await db
    .select({ id: notifications.id, state: notifications.state })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, 'issue_stranded'),
        eq(notifications.resolutionKey, resolutionKey),
        isNull(notifications.resolvedAt),
        or(
          inArray(notifications.state, ['pending', 'firing', 'inhibited']),
          gte(notifications.createdAt, new Date(args.now.getTime() - ORPHAN_RENOTIFY_MS)),
        ),
      ),
    )
    .limit(1);

  if (existing) {
    await emit(args, resolutionKey);
    return false;
  }

  logger.warn(
    {
      projectId: args.row.projectId,
      issue: args.ref,
      status: args.row.status,
      assertingSince: args.row.since,
      detectedAt: args.now,
    },
    'issue-run-invariant: this issue says work is in progress and no live run is behind it — nothing has been moved',
  );

  await emit(args, resolutionKey);
  return true;
}

/**
 * Tell this project's admins about one orphan episode.
 */
async function emit(
  args: { now: Date; row: OrphanRow; ref: string },
  resolutionKey: string,
): Promise<void> {
  const admins = await projectAdminUserIds(args.row.projectId);
  if (admins.length === 0) return;
  await emitNotification({
    recipients: admins,
    projectId: args.row.projectId,
    issueId: args.row.issueId,
    type: 'issue_stranded',
    resolutionKey,
    groupKey: sweepGroupKey('orphan-assertion', args.now),
    groupTitle: 'Issues asserting work in progress with no run behind them',
    title: `${args.ref} says work is in progress with no run behind it`,
    body:
      `${args.ref} (${args.row.status}) has asserted work in progress since ` +
      `${args.row.since} and no job, issue run or run session is live for it. ` +
      'Nothing has been moved: whether the issue or the run record is the wrong half is not ' +
      'decidable from here.',
  });
}

/**
 * One sweep of the inverse edge. Reports; moves nothing.
 */
export async function detectOrphanedRunAssertions(
  now: Date = new Date(),
): Promise<IssueRunInvariantResult> {
  const rows = await orphanedAssertions(now);
  let reported = 0;
  for (const row of rows) {
    const ref = formatIssueRef(row.issuePrefix, row.issSeq);
    if (await nameOnce({ now, row, ref })) reported += 1;
  }
  return { detected: rows.length, reported };
}
