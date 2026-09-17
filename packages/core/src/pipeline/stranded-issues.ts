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

import { and, eq, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStatuses, issues, projects } from '../db/schema.js';
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

/*
 * ISS-1063 — `STRANDED_RENOTIFY_MS` was DELETED here, and so was the lookup it bounded.
 *
 * It was a 24-hour cooldown, and what it existed to stop was real: the dedupe keyed on an
 * UNREAD notification, so a human glancing at the bell re-armed the alarm and the 60-second
 * sweep pinged them again within the minute, every minute, for the life of the park.
 *
 * Read state is not on the record any more — that is the whole of ISS-1063 — so nothing a
 * reader does re-arms anything, and the cooldown had no storm left to prevent. What replaced
 * it is the delivery layer's own dedup: `deliver.ts:activeRecord` makes a second emission of
 * one identity the SAME condition rather than a new one, and `deliverTo` writes no delivery
 * for a person who already holds a member link for that record. So this pass now re-emits
 * every strand on every tick and tells nobody twice — which is what it takes to promote a
 * `pending` record, to stamp the `last_seen_at` that `pipeline/reevaluate-conditions.ts`
 * reads for staleness, and to deliver a record whose telling a silence held back.
 */

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
 * ISS-1063 — the grouping key: one evaluation of one detector.
 *
 * Alertmanager's `group_by`. Every strand this sweep tick finds shares it, so a reader is
 * told once about the sweep rather than once per issue it named. The tick is truncated to
 * the evaluation interval so the passes inside one `runPipelineSweep` agree on it without
 * having to pass a value between them.
 */
export function sweepGroupKey(detector: string, now: Date): string {
  return `sweep:${detector}:${Math.floor(now.getTime() / 60_000)}`;
}

// cm:edge lockstep -> packages/core/src/notifications/notify-transitions.ts — the key is cleared when the issue reaches a terminal placement, and a key nothing clears is an alarm that stays lit after the close it asked for
export function owedCloseResolutionKey(issueId: string): string {
  return `issue:${issueId}:owed-close`;
}

/**
 * Emit one `issue_stranded` condition for this strand and return how many people were NEWLY
 * told about it — 0 when everybody who can act already holds it, and `-1` when the project
 * has no admin at all, which is the one case a `notified` count of zero cannot distinguish
 * from "nothing to say".
 */
// cm:guard ISS-1063 — "already surfaced" is the DELIVERY layer's question now, and it is not
// asked here. A strand that ends is stamped `resolved_at` by `notifications/auto-resolve.ts`,
// and `deliver.ts:activeRecord` reads exactly that column: a re-emission joins the record
// that is still active and creates a new one once the old strand has ended. That is what
// makes a genuine RE-strand loud on the tick it happens rather than muted for the rest of a
// window, in the module whose whole job is breaking silence.
async function surfaceOnce(args: {
  now: Date;
  projectId: string;
  issueId: string;
  resolutionKey: string;
  title: string;
  body: string;
  groupKey: string;
  groupTitle: string;
}): Promise<number> {
  // cm:guard ISS-1063 — this pass no longer asks whether the strand was already surfaced,
  // and the deletion is the point rather than an omission. `emitNotification` returns who was
  // NEWLY told, which is 0 for a record everybody already holds, and three things need the
  // re-emission that a short-circuit here made impossible: a `pending` record is promoted to
  // `firing` by a LATER emission of the same identity, `last_seen_at` is what stops that
  // pending record going stale, and a record whose delivery a silence held back is delivered
  // when the silence expires. Do not put a producer-level "already exists" guard back: it
  // would make all three unreachable while looking like a saved query.
  const adminIds = await projectAdminUserIds(args.projectId);
  if (adminIds.length === 0) return -1;
  // cm:why ISS-1063 — ONE record, a delivery per admin, where this used to write one row
  // per admin: 2997 `issue_stranded` rows on the replica were 545 conditions wearing
  // their recipients' names. The `groupKey` is the sweep tick, so every strand one
  // evaluation finds reaches each admin as one notification naming the cause — the 11:21
  // burst of 2026-09-16 was 15 conditions and the owner was told fifteen times.
  // cm:guard what comes back is who was NEWLY told, and the caller reports that as
  // `notified`. Returning `adminIds.length` here would count a pending record nobody was
  // told about as two notifications, which is a detector reporting work it did not do.
  const sent = await emitNotification({
    recipients: adminIds,
    projectId: args.projectId,
    issueId: args.issueId,
    type: 'issue_stranded',
    title: args.title,
    body: args.body,
    resolutionKey: args.resolutionKey,
    groupKey: args.groupKey,
    groupTitle: args.groupTitle,
  });
  return sent?.delivered ?? 0;
}

/**
 * Surface every `waiting` park that is past {@link STRANDED_GRACE_MS} and has
 * nothing coming for it. Best-effort: never throws — a failure here must not
 * abort the sweep.
 */
// cm:guard the age is measured from `updated_at`, and the `merged_at` arm this used to carry alongside it went with the staged lane (ISS-895): a park in this lane has no merge to date it from, so a `merged_at`-only test would age nothing and this pass would report zero forever.
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
        groupKey: sweepGroupKey('stranded', now),
        groupTitle: 'Issues are parked with nothing coming for them',
        projectId: row.projectId,
        issueId: row.id,
        resolutionKey: strandedResolutionKey(row.id),
        title: `${ref} is waiting on you — ${row.projectName}`,
        body: `${lead}, so nothing will move it forward until you decide. Open it and read the last comment: a step that could not finish its checks leaves the decision here.`,
      });
      if (sent < 0) unreachable += 1;
      else notified += sent;
    }

    // cm:guard gated on `notified`, NOT on `detected` — a park already surfaced is not news, and this runs every 60s against a predicate that matches every parked issue on an autonomous project. Logging the detection instead reprints the same issue ids each minute for as long as the park lasts, which buries the tick where something actually changed.
    // cm:guard `unreachable` is the second arm and is NOT redundant: a project with no admin at all (`projectAdminUserIds` returns none) notifies nobody, so gating on `notified` alone would make the one case where the alarm reaches NO human the one case that also prints nothing.
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
// cm:guard `merged_at` alone is NOT this shape and never becomes it — a reopened issue carries the stamp of its first landing while real work is in flight. The live-job and running-run exclusions are what separate the two, and dropping either turns this alarm on every issue that has ever shipped anything (ISS-940).
// cm:edge lockstep -> packages/core/src/pipeline/reconciler.ts — the rescue pass excludes exactly these rows from re-dispatch, so this is the only thing that says a stamped issue exists; drop it and the exclusion becomes the silence it was added to replace
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
          // cm:guard write `issues.id` LITERALLY in both subqueries — drizzle renders a column reference interpolated into a raw `sql` template UNQUALIFIED, so `${'$'}{issues.id}` becomes a bare `id`, which inside `from jobs j` resolves to `j.id` and makes the clause `j.issue_id = j.id`: never true, `not exists` always true, and the exclusion silently disappears. Caught by owed-close-e2e.test.ts, which is the only place it can be caught.
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
        groupKey: sweepGroupKey('owed-close', now),
        groupTitle: 'Issues whose code shipped and whose close was never written',
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
