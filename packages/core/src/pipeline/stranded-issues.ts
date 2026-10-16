import { and, asc, desc, eq, isNotNull, isNull, notInArray, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueStatuses, issues, projects } from '../db/schema.js';
import { statusEnteredAtSql } from '../issues/status-entered-at.js';
import { statusLabel } from '../issues/status-sets.js';
import { elapsedWords } from '../lib/elapsed-words.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { type SweepDetector, sweepGroup } from '../notifications/explanations.js';
import { projectAdminUserIdsFor } from '../notifications/project-admins.js';
import { resolveArchivedProjectNotices } from './archived-project-notices.js';
import {
  FRESH_SIGHTING_LIMIT,
  pendingConditionSql,
  pendingSightingLimit,
  unraisedConditionSql,
  withOwed,
} from './owed-sighting.js';
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

const STRANDED_KEY_SUFFIX = ':stranded';
const OWED_CLOSE_KEY_SUFFIX = ':owed-close';

export function strandedResolutionKey(issueId: string): string {
  return `issue:${issueId}${STRANDED_KEY_SUFFIX}`;
}

export function owedCloseResolutionKey(issueId: string): string {
  return `issue:${issueId}${OWED_CLOSE_KEY_SUFFIX}`;
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
  detector: SweepDetector;
}): Promise<number> {
  const adminIds = args.admins.get(args.projectId) ?? [];
  if (adminIds.length === 0) return -1;
  const sent = await emitNotification(
    {
      recipients: adminIds,
      projectId: args.projectId,
      issueId: args.issueId,
      type: 'issue_stranded',
      title: args.title,
      body: args.body,
      resolutionKey: args.resolutionKey,
      ...sweepGroup(args.detector, args.now),
    },
    args.now,
  );
  return sent?.delivered ?? 0;
}

/** When the issue was parked: the row's own `updated_at` moves on any write (ISS-1229). */
const PARKED_AT = statusEnteredAtSql({
  id: sql`"issues"."id"`,
  status: sql`"issues"."status"`,
  createdAt: sql`"issues"."created_at"`,
});

type Scope = { projectId?: string };

/** One read of waiting parks on live projects, `where` narrowing it, oldest or newest park first. */
function readParks(args: { scope: Scope; where: SQL[]; newestFirst: boolean; limit: number }) {
  const order = args.newestFirst ? desc : asc;
  return db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      issuePrefix: projects.issuePrefix,
      issSeq: issues.issSeq,
      title: issues.title,
      mergedAt: issues.mergedAt,
      parkedAt: sql<string>`${PARKED_AT}::text`,
      cursorTs: sql<string>`${PARKED_AT}::text`,
      projectName: projects.name,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(
        eq(issues.status, 'waiting'),
        isNull(projects.archivedAt),
        ...(args.scope.projectId ? [eq(issues.projectId, args.scope.projectId)] : []),
        ...args.where,
      ),
    )
    .orderBy(order(PARKED_AT), order(issues.id))
    .limit(args.limit);
}

const TERMINAL = issueStatuses.filter(isTerminalPlacement);

/** One read of merged issues still open with nothing running, `where` narrowing it, by merge time. */
function readOwedCloses(args: { scope: Scope; where: SQL[]; newestFirst: boolean; limit: number }) {
  const order = args.newestFirst ? desc : asc;
  return db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      issuePrefix: projects.issuePrefix,
      issSeq: issues.issSeq,
      status: issues.status,
      title: issues.title,
      mergedAt: issues.mergedAt,
      cursorTs: sql<string>`"issues"."merged_at"::text`,
      projectName: projects.name,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(
        isNotNull(issues.mergedAt),
        isNull(projects.archivedAt),
        notInArray(issues.status, TERMINAL),
        sql`not exists (select 1 from jobs j where j.issue_id = issues.id and j.status in ('queued','dispatched','running'))`,
        sql`not exists (select 1 from pipeline_runs r where r.issue_id = issues.id and r.status = 'running')`,
        ...(args.scope.projectId ? [eq(issues.projectId, args.scope.projectId)] : []),
        ...args.where,
      ),
    )
    .orderBy(order(issues.mergedAt), order(issues.id))
    .limit(args.limit);
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
    await resolveArchivedProjectNotices(STRANDED_KEY_SUFFIX);
    const cutoff = new Date(now.getTime() - STRANDED_GRACE_MS);

    const cursorKey = `stranded:${scope.projectId ?? '*'}`;
    // The staleness cutoff IS this traversal's far edge: it is the bound that walks forward with
    // the clock and lets newly-aged strands in, so freezing it for the traversal's length is what
    // makes the set finite and the wrap reachable.
    const window = sweepWindow(cursorKey, cutoff.toISOString());

    const page = await readParks({
      scope,
      where: [
        sql`${PARKED_AT} < ${window.until}::timestamptz`,
        ...(window.after
          ? [
              sql`(${PARKED_AT}, "issues"."id") > (${window.after.ts}::timestamptz, ${window.after.id}::uuid)`,
            ]
          : []),
      ],
      newestFirst: false,
      limit: STRANDED_SCAN_LIMIT,
    });

    const filled = page.length === STRANDED_SCAN_LIMIT;
    const lastRow = page.at(-1);
    const last: SweepPosition | null = lastRow ? { ts: lastRow.cursorTs, id: lastRow.id } : null;
    advanceSweep(cursorKey, window, last, filled);

    const rows = withOwed(
      page,
      await readParks({
        scope,
        where: [pendingConditionSql(sql`"issues"."id"`, STRANDED_KEY_SUFFIX)],
        newestFirst: false,
        limit: pendingSightingLimit(STRANDED_SCAN_LIMIT),
      }),
      await readParks({
        scope,
        where: [
          unraisedConditionSql(sql`"issues"."id"`, STRANDED_KEY_SUFFIX),
          sql`${PARKED_AT} < ${cutoff.toISOString()}::timestamptz`,
        ],
        newestFirst: true,
        limit: FRESH_SIGHTING_LIMIT,
      }),
    );

    const admins = await projectAdminUserIdsFor(rows.map((r) => r.projectId));

    let notified = 0;
    let unreachable = 0;
    for (const row of rows) {
      const ref = row.issSeq !== null ? formatIssueRef(row.issuePrefix, row.issSeq) : 'An issue';
      const age = elapsedWords(row.mergedAt ?? row.parkedAt, now);
      const lead = row.mergedAt
        ? `its code merged ${age} ago but the issue is still parked`
        : `it has been parked for ${age}`;

      const sent = await surfaceOnce({
        now,
        admins,
        detector: 'stranded',
        projectId: row.projectId,
        issueId: row.id,
        resolutionKey: strandedResolutionKey(row.id),
        title: `${ref} is waiting on you — ${row.projectName}`,
        body: `${ref} "${row.title}": ${lead}.`,
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
    await resolveArchivedProjectNotices(OWED_CLOSE_KEY_SUFFIX);
    const cutoff = new Date(now.getTime() - STRANDED_GRACE_MS);

    const cursorKey = `owed-close:${scope.projectId ?? '*'}`;
    const window = sweepWindow(cursorKey, cutoff.toISOString());

    const page = await readOwedCloses({
      scope,
      where: [
        sql`"issues"."merged_at" < ${window.until}::timestamptz`,
        ...(window.after
          ? [
              sql`("issues"."merged_at", "issues"."id") > (${window.after.ts}::timestamptz, ${window.after.id}::uuid)`,
            ]
          : []),
      ],
      newestFirst: false,
      limit: STRANDED_SCAN_LIMIT,
    });

    const filled = page.length === STRANDED_SCAN_LIMIT;
    const lastRow = page.at(-1);
    const last: SweepPosition | null = lastRow ? { ts: lastRow.cursorTs, id: lastRow.id } : null;
    advanceSweep(cursorKey, window, last, filled);

    const rows = withOwed(
      page,
      await readOwedCloses({
        scope,
        where: [pendingConditionSql(sql`"issues"."id"`, OWED_CLOSE_KEY_SUFFIX)],
        newestFirst: false,
        limit: pendingSightingLimit(STRANDED_SCAN_LIMIT),
      }),
      await readOwedCloses({
        scope,
        where: [
          unraisedConditionSql(sql`"issues"."id"`, OWED_CLOSE_KEY_SUFFIX),
          sql`"issues"."merged_at" < ${cutoff.toISOString()}::timestamptz`,
        ],
        newestFirst: true,
        limit: FRESH_SIGHTING_LIMIT,
      }),
    );

    const admins = await projectAdminUserIdsFor(rows.map((r) => r.projectId));

    let notified = 0;
    let unreachable = 0;
    for (const row of rows) {
      const ref = row.issSeq !== null ? formatIssueRef(row.issuePrefix, row.issSeq) : 'An issue';
      // The query admits only rows carrying a merge mark, so `mergedAt` is never null here.
      const age = elapsedWords(row.mergedAt as Date, now);
      const sent = await surfaceOnce({
        now,
        admins,
        detector: 'owed-close',
        projectId: row.projectId,
        issueId: row.id,
        resolutionKey: owedCloseResolutionKey(row.id),
        title: `${ref} shipped but never closed — ${row.projectName}`,
        body: `${ref} "${row.title}" has carried a merge mark for ${age} while it still reads ${statusLabel(row.status)}, with nothing running on it.`,
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
