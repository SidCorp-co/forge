import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStatuses, issues, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { projectAdminUserIdsFor } from '../notifications/project-admins.js';
import { isTerminalPlacement } from './status-assertions.js';
import { advanceSweep, type SweepPosition, sweepWindow } from './sweep-cursor.js';

/**
 * How many strands one pass surfaces, matching the run axis and `PAUSED_RUN_SCAN_LIMIT`.
 *
 * ISS-1021 — the bound alone would be a blind spot, because neither detector writes anything on
 * the row it surfaces and so never removes it from its own candidate set. `sweep-cursor.ts` is the
 * other half: the pass resumes after the last key it read and wraps at the end.
 */
export const STRANDED_SCAN_LIMIT = 200;

/** One pass's memo of `projectAdminUserIdsFor`, filled in one round trip before the loop. */
type AdminsByProject = ReadonlyMap<string, string[]>;

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

export function owedCloseResolutionKey(issueId: string): string {
  return `issue:${issueId}:owed-close`;
}

/**
 * Emit one `issue_stranded` condition for this strand and return how many people were NEWLY
 * told about it — 0 when everybody who can act already holds it, and `-1` when the project
 * has no admin at all, which is the one case a `notified` count of zero cannot distinguish
 * from "nothing to say".
 */
async function surfaceOnce(args: {
  now: Date;
  admins: AdminsByProject;
  projectId: string;
  issueId: string;
  resolutionKey: string;
  title: string;
  body: string;
  groupKey: string;
  groupTitle: string;
}): Promise<number> {
  const adminIds = args.admins.get(args.projectId) ?? [];
  if (adminIds.length === 0) return -1;
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
export async function detectStrandedIssues(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<StrandedIssuesResult> {
  try {
    const cutoff = new Date(now.getTime() - STRANDED_GRACE_MS);

    const cursorKey = `stranded:${scope.projectId ?? '*'}`;
    // The staleness cutoff IS this traversal's far edge: it is the bound that walks forward with
    // the clock and lets newly-aged strands in, so freezing it for the traversal's length is what
    // makes the set finite and the wrap reachable.
    const window = sweepWindow(cursorKey, cutoff.toISOString());

    const rows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        issuePrefix: projects.issuePrefix,
        issSeq: issues.issSeq,
        title: issues.title,
        mergedAt: issues.mergedAt,
        updatedAt: issues.updatedAt,
        cursorTs: sql<string>`"issues"."updated_at"::text`,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          eq(issues.status, 'waiting'),
          sql`"issues"."updated_at" < ${window.until}::timestamptz`,
          ...(scope.projectId ? [eq(issues.projectId, scope.projectId)] : []),
          ...(window.after
            ? [
                sql`("issues"."updated_at", "issues"."id") > (${window.after.ts}::timestamptz, ${window.after.id}::uuid)`,
              ]
            : []),
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(STRANDED_SCAN_LIMIT);

    const filled = rows.length === STRANDED_SCAN_LIMIT;
    const lastRow = rows.at(-1);
    const last: SweepPosition | null = lastRow ? { ts: lastRow.cursorTs, id: lastRow.id } : null;
    advanceSweep(cursorKey, window, last, filled);

    const admins = await projectAdminUserIdsFor(rows.map((r) => r.projectId));

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
        admins,
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

    if (notified > 0 || unreachable > 0) {
      logger.warn(
        { detected: rows.length, notified, unreachable, issueIds: rows.map((r) => r.id) },
        'stranded-issues: a waiting park with nothing coming for it',
      );
    }

    if (filled) {
      logger.warn(
        { limit: STRANDED_SCAN_LIMIT, examined: rows.length, resumesAfter: last?.ts ?? null },
        'stranded-issues: the waiting-park scan filled its page — the rest is read on later passes',
      );
    }

    return { detected: rows.length, notified };
  } catch (err) {
    logger.error({ err }, 'stranded-issues: detection failed');
    return { detected: 0, notified: 0 };
  }
}

export async function detectOwedCloses(
  now: Date = new Date(),
  scope: { projectId?: string } = {},
): Promise<StrandedIssuesResult> {
  try {
    const cutoff = new Date(now.getTime() - STRANDED_GRACE_MS);
    const terminal = issueStatuses.filter(isTerminalPlacement);

    const cursorKey = `owed-close:${scope.projectId ?? '*'}`;
    const window = sweepWindow(cursorKey, cutoff.toISOString());

    const rows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        issuePrefix: projects.issuePrefix,
        issSeq: issues.issSeq,
        status: issues.status,
        mergedAt: issues.mergedAt,
        cursorTs: sql<string>`"issues"."merged_at"::text`,
        projectName: projects.name,
      })
      .from(issues)
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .where(
        and(
          isNotNull(issues.mergedAt),
          sql`"issues"."merged_at" < ${window.until}::timestamptz`,
          notInArray(issues.status, terminal),
          ...(window.after
            ? [
                sql`("issues"."merged_at", "issues"."id") > (${window.after.ts}::timestamptz, ${window.after.id}::uuid)`,
              ]
            : []),
          sql`not exists (select 1 from jobs j where j.issue_id = issues.id and j.status in ('queued','dispatched','running'))`,
          sql`not exists (select 1 from pipeline_runs r where r.issue_id = issues.id and r.status = 'running')`,
          ...(scope.projectId ? [eq(issues.projectId, scope.projectId)] : []),
        ),
      )
      .orderBy(asc(issues.mergedAt), asc(issues.id))
      .limit(STRANDED_SCAN_LIMIT);

    const filled = rows.length === STRANDED_SCAN_LIMIT;
    const lastRow = rows.at(-1);
    const last: SweepPosition | null = lastRow ? { ts: lastRow.cursorTs, id: lastRow.id } : null;
    advanceSweep(cursorKey, window, last, filled);

    const admins = await projectAdminUserIdsFor(rows.map((r) => r.projectId));

    let notified = 0;
    let unreachable = 0;
    for (const row of rows) {
      const ref = row.issSeq !== null ? formatIssueRef(row.issuePrefix, row.issSeq) : 'An issue';
      const days = Math.floor((now.getTime() - (row.mergedAt?.getTime() ?? 0)) / 86_400_000);
      const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : 'hours';
      const sent = await surfaceOnce({
        now,
        admins,
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

    if (filled) {
      logger.warn(
        { limit: STRANDED_SCAN_LIMIT, examined: rows.length, resumesAfter: last?.ts ?? null },
        'stranded-issues: the owed-close scan filled its page — the rest is read on later passes',
      );
    }

    return { detected: rows.length, notified };
  } catch (err) {
    logger.error({ err }, 'stranded-issues: owed-close detection failed');
    return { detected: 0, notified: 0 };
  }
}
