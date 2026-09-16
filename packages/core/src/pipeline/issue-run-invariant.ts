/**
 * The inverse edge: an issue asserting work that no live run is behind.
 *
 * It lives beside `stranded-issues.ts` rather than in `devices/`, where its
 * forward twin `devices/admissible.ts` is, because it is a sweeper pass and
 * the sweeper is what runs it. Under `devices/` it pushed `pipeline/sweeper.ts`
 * to a seventh module and the archmap gate refused it — correctly: a pass the
 * sweeper owns reaching back across a layer boundary is the coordination this
 * repo caps.
 *
 * `devices/admissible.ts` asks the forward question — may this issue be handed
 * out? — and excludes any issue with a live job, a live issue run, or a live
 * run session naming it. This pass asks the same question backwards: an issue
 * whose STATUS asserts work in progress, for which none of those three exists.
 *
 * It reports and moves nothing, and that is a decision rather than an omission.
 * `reapDeadRunSessions` may retract, because it holds the one fact that makes
 * retraction sound: a run session it opened stopped beating, so the assertion
 * that run made is now false and the issue goes back to the status it held when
 * that run opened. This pass holds no such fact. An issue reaches `in_progress`
 * on this project by a baseline record a person or a by-hand run wrote, not only
 * by a run session, so an arm that retracted here would pull the tree out from
 * under exactly that work. Whether the issue or the run record is the wrong half
 * is not computable from either side; saying they disagree is.
 */

import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { projectAdminUserIds } from '../notifications/project-admins.js';
import { sweepGroupKey } from './stranded-issues.js';

/**
 * The statuses whose meaning is "a run is working this right now".
 */
// cm:guard the same three as `devices/run-issue-return.ts#RETURNABLE_FROM`, and for the same reason: they are exactly the statuses a run session PUTS an issue into and takes it out of. A status outside them is one no run asserts, so its having no run behind it says nothing at all.
// cm:edge lockstep -> packages/core/src/devices/run-issue-return.ts — widen one without the other and this pass reports issues the return path would never have touched.
export const ASSERTS_WORK_IN_PROGRESS = ['in_progress', 'testing', 'releasing'] as const;

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
// cm:guard this MUST stay far wider than the sweep interval (`pipeline/sweeper.ts`, 60s). The predicate matches for as long as the disagreement lasts, which is until a human resolves it, so without a cooldown this is one line per orphan per minute forever — and a warning repeated every minute is a warning nobody reads, which is the same silence it exists to break.
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
// cm:guard REUSES `issue_stranded` rather than adding an enum value, and the trade-off is
// deliberate: `stranded-issues.ts` already carries two shapes under that one type "because a reader
// owes both the same act", and this is a third shape owing the same act — a human decides which
// half is wrong. What it costs is that a reader filtering by type alone cannot tell the three
// apart; the `resolutionKey` below is what tells them apart, and it is what `auto-resolve.ts`
// keys on. What would end the amnesty is a reader that needs to subscribe to this shape and not
// the other two, and that reader would come with the migration that adds the value.
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
  // cm:guard a STRING, not a `Date`. A raw `db.execute` returns `timestamptz` in the driver's own
  // wire form rather than through drizzle's column decoders, so typing this `Date` compiles and
  // then throws `args.row.since.toISOString is not a function` at the moment the pass has something
  // to report — green on every tick where there is nothing to say.
  since: string;
}

/**
 * Every issue asserting work that nothing live is behind.
 */
// cm:guard the three NOT EXISTS clauses are the INVERSE of `devices/admissible.ts`'s three and must stay the same three. Dropping one here reports issues that are being worked by the half this forgot to look at; adding one there without adding it here leaves a way to be worked that this pass calls an orphan.
// cm:edge lockstep -> packages/core/src/devices/admissible.ts — one predicate, read in two directions.
async function orphanedAssertions(now: Date): Promise<OrphanRow[]> {
  // cm:guard the bound value is an ISO STRING, not a `Date`. `db.execute` with a raw tagged
  // template binds parameters through the driver directly rather than through drizzle's column
  // encoders, and this driver refuses a `Date` there — `ERR_INVALID_ARG_TYPE`, at runtime, on the
  // one pass whose whole job is to break a silence. Caught by the integration test rather than by
  // the typechecker, because `sql` accepts `unknown`.
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
            -- cm:guard CANONICAL, the form openRunSession stores, never the project's own
            -- prefix: matching on issue_prefix here makes a live run's issues invisible to
            -- this pass and every one of them is reported as an orphan (ISS-992)
            AND rs.metadata -> 'runIssues' @> to_jsonb('ISS-' || i.iss_seq) -- ISS-992:canonical
       )
  `)) as unknown as OrphanRow[];
}

/**
 * Name one orphan episode, unless this episode is already named.
 */
// cm:guard `resolved_at IS NULL` stays OUTSIDE the `or`: a resolved row is an episode that ENDED, and suppressing on it would mute a genuine second episode on the same issue for the rest of the window. Inside the `or`, unread **or** recently sent — existence alone names an episode once and never again however long it lasts, and unread alone re-names it every tick from the moment somebody reads it.
async function nameOnce(args: { now: Date; row: OrphanRow; ref: string }): Promise<boolean> {
  const resolutionKey = orphanedAssertionResolutionKey(args.row.issueId);
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, 'issue_stranded'),
        eq(notifications.resolutionKey, resolutionKey),
        isNull(notifications.resolvedAt),
        // cm:guard ISS-1063 — `state <> 'resolved'` where this read `read = false`, for the reason the same guard in stranded-issues.ts carries: read state is a fact about a person and is not on this table any more, and an episode still firing is the thing that must not be named twice.
        or(
          inArray(notifications.state, ['pending', 'firing', 'inhibited']),
          gte(notifications.createdAt, new Date(args.now.getTime() - ORPHAN_RENOTIFY_MS)),
        ),
      ),
    )
    .limit(1);
  if (existing) return false;

  // cm:guard the log line is the deliverable and is emitted whether or not anyone is reachable by
  // notification. A project with no admin would otherwise make this pass silent on exactly the box
  // nobody is watching, and a `reported` count of zero would be indistinguishable from no orphan.
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

  const admins = await projectAdminUserIds(args.row.projectId);
  if (admins.length > 0) {
    // cm:guard ISS-1063 changed the SHAPE of what this writes — one record and a delivery
    // per admin instead of a row per admin — and changed nothing about WHEN it writes.
    // The predicate above, the log line, and this alarm's grace window are untouched: the
    // issue that asked for this refactor named this detector as the one thing it must not
    // regress.
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
  return true;
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
