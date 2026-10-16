import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { issueWorkInFlightSql } from '../issues/issue-lease.js';
import { lastWorkedAtSql } from '../issues/status-entered-at.js';
import { ASSERTS_WORK_IN_PROGRESS, statusLabel } from '../issues/status-sets.js';
import { elapsedWords } from '../lib/elapsed-words.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { resolveNotifications } from '../notifications/auto-resolve.js';
import { emitNotification } from '../notifications/emit.js';
import { sweepGroup } from '../notifications/explanations.js';
import { projectAdminUserIds } from '../notifications/project-admins.js';

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
  /** Named episodes whose cause had ended, now resolved. */
  resolved: number;
}

/**
 * The notification type this reports under.
 */
export function orphanedAssertionResolutionKey(issueId: string): string {
  return `issue:${issueId}:run-assertion-orphaned`;
}

const ORPHAN_KEY_SUFFIX = ':run-assertion-orphaned';

/**
 * Resolve every named orphan whose cause has ended: the issue left the asserting statuses, or a
 * job, run or lease is behind it again. The detector's predicate without its grace, so a write
 * that only moves the issue's clock ends nothing.
 */
export async function resolveEndedOrphanAssertions(): Promise<number> {
  const ended = (await db.execute(sql`
    SELECT DISTINCT n.resolution_key AS "key"
      FROM notifications n
      JOIN issues i ON i.id = n.issue_id
      JOIN projects p ON p.id = i.project_id
     WHERE n.type = 'issue_stranded'
       AND n.resolved_at IS NULL
       AND n.resolution_key LIKE ${`issue:%${ORPHAN_KEY_SUFFIX}`}
       AND (
         i.status NOT IN (${sql.join(
           ASSERTS_WORK_IN_PROGRESS.map((s) => sql`${s}`),
           sql`, `,
         )})
         OR ${issueWorkInFlightSql({
           issueId: sql`i.id`,
           projectId: sql`i.project_id`,
           issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
         })}
       )
  `)) as unknown as { key: string }[];
  let resolved = 0;
  for (const { key } of ended) resolved += await resolveNotifications(key);
  return resolved;
}

interface OrphanRow {
  issueId: string;
  projectId: string;
  issSeq: number;
  issuePrefix: string | null;
  projectName: string;
  status: string;
  title: string;
  /** When the last work on the issue ended, or it entered its status if later: Postgres's own text. */
  since: string;
}

/**
 * What the project's admins read about one orphan: the issue with its project, the status in the
 * screen's word, and how long nothing has worked it, never the stored time a raw query hands back.
 */
export function orphanNotice(args: {
  ref: string;
  projectName: string;
  status: string;
  since: string;
  now: Date;
}): { title: string; body: string } {
  return {
    title: `${args.ref} says work is in progress with no run behind it — ${args.projectName}`,
    body:
      `${args.ref} reads ${statusLabel(args.status)}, and nothing has worked it for ${elapsedWords(args.since, args.now)}: ` +
      'no job, issue run or run session is live for it.',
  };
}

/** Counted from the work's end, not the row's last write: a later edit moves `updated_at` (ISS-1229). */
const ORPHAN_SINCE = lastWorkedAtSql({
  id: sql`i.id`,
  status: sql`i.status`,
  createdAt: sql`i.created_at`,
  projectId: sql`i.project_id`,
  issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
});

async function orphanedAssertions(now: Date): Promise<OrphanRow[]> {
  const cutoff = new Date(now.getTime() - ORPHAN_ASSERTION_GRACE_MS).toISOString();
  return (await db.execute(sql`
    SELECT i.id            AS "issueId",
           i.project_id    AS "projectId",
           i.iss_seq       AS "issSeq",
           p.issue_prefix  AS "issuePrefix",
           p.name          AS "projectName",
           i.status        AS "status",
           i.title         AS "title",
           ${ORPHAN_SINCE} AS "since"
      FROM issues i
      JOIN projects p ON p.id = i.project_id
     WHERE i.status IN (${sql.join(
       ASSERTS_WORK_IN_PROGRESS.map((s) => sql`${s}`),
       sql`, `,
     )})
       -- Which issues are named is unchanged; only what the notice counts from is ORPHAN_SINCE.
       AND i.updated_at < ${cutoff}
       -- the same predicate the admissible read uses (ISS-1109). This pass and that one
       -- were verbatim twins, and a sweep that drifts from the pool reports as orphaned
       -- exactly the issues a box is working. Matching on issue_prefix here would make a
       -- live run's issues invisible to this pass and report every one (ISS-992).
       AND NOT ${issueWorkInFlightSql({
         issueId: sql`i.id`,
         projectId: sql`i.project_id`,
         issueKey: sql`'ISS-' || i.iss_seq`, // ISS-992:canonical
       })}
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
    ...sweepGroup('orphan-assertion', args.now),
    ...orphanNotice({
      ref: args.ref,
      projectName: args.row.projectName,
      status: args.row.status,
      since: args.row.since,
      now: args.now,
    }),
  });
}

/**
 * One sweep of the inverse edge. Reports; moves nothing.
 */
export async function detectOrphanedRunAssertions(
  now: Date = new Date(),
): Promise<IssueRunInvariantResult> {
  const resolved = await resolveEndedOrphanAssertions();
  const rows = await orphanedAssertions(now);
  let reported = 0;
  for (const row of rows) {
    const ref = formatIssueRef(row.issuePrefix, row.issSeq);
    if (await nameOnce({ now, row, ref })) reported += 1;
  }
  return { detected: rows.length, reported, resolved };
}
