import type { StuckIssueKind } from '@forge/contracts/notifications';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns, projectMembers, projects, runners, users } from '../db/schema.js';
import { HUMAN_PARK_STATUSES } from '../issues/status-sets.js';
import { readWorkStateRows } from '../issues/work-state-read.js';
import { createLimiter } from '../lib/bounded-concurrency.js';
import { heldAsFailedJobWhere } from '../me/attention-failed-jobs.js';
import { readLiveSessionCounts } from '../pipeline/live-session.js';
import { firstShipped } from '../pipeline/shipped-at.js';
import {
  parkOwerNameSql,
  parkOwerSql,
  readerStuckKindSql,
  stuckRankSql,
} from './stuck-issue-kinds.js';

/**
 * The twelve independent per-project reads behind `GET /api/projects/health`, and
 * the bound they run under, so the latency is a few waves rather than one round
 * trip per read.
 */

export const HEALTH_READ_CONCURRENCY = 4;
const healthReadLimiter = createLimiter(HEALTH_READ_CONCURRENCY);

/** In flight and parked, for the test that asserts the bound holds. */
export const healthReadLoad = {
  get inFlight() {
    return healthReadLimiter.inFlight;
  },
  get waiting() {
    return healthReadLimiter.waiting;
  },
};

/** Every status a person parks an issue at, whoever owns it: the set the Held list holds by person. */
export const BLOCKED_STATUSES = HUMAN_PARK_STATUSES;

export type BlockerRow = {
  projectId: string;
  id: string;
  issSeq: number;
  issuePrefix: string | null;
  title: string;
  status: string;
  /** Whether the reader owns the park (its assignee, else whoever filed it): theirs to act on. */
  readerOwns: boolean;
};

function idList(projectIds: string[]) {
  return sql.join(
    projectIds.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** How many issues sit at each status, split by whether a person owes one an answer — the rows `foldWorkStates` counts work from. */
const readStatusRows = (projectIds: string[]) =>
  readWorkStateRows(inArray(issues.projectId, projectIds), false);

const readBlockerRows = (projectIds: string[], readerId: string) =>
  db
    .select({
      projectId: issues.projectId,
      id: issues.id,
      issSeq: issues.issSeq,
      issuePrefix: projects.issuePrefix,
      title: issues.title,
      status: issues.status,
      updatedAt: issues.updatedAt,
      readerOwns: sql<boolean>`(${parkOwerSql(sql`${issues.id}`)} IS NOT DISTINCT FROM ${readerId}::uuid)`,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(inArray(issues.projectId, projectIds), inArray(issues.status, [...BLOCKED_STATUSES])),
    )
    .orderBy(issues.projectId, sql`${issues.updatedAt} DESC`);

export type ThroughputRow = { projectId: string; n: number };

const lastSevenDays = (projectIds: string[]) =>
  firstShipped({ projectIds, from: sql`now() - interval '7 days'` });

const readThroughputRows = (projectIds: string[]) =>
  db.execute(sql`
    SELECT f.project_id AS "projectId", count(*)::int AS n
    FROM (${lastSevenDays(projectIds)}) f
    GROUP BY f.project_id
  `) as unknown as Promise<ThroughputRow[]>;

export type CycleRow = { project_id: string; avg_days: number | null };

const readCycleRows = (projectIds: string[]) =>
  db.execute(sql`
    WITH completions AS (
      SELECT f.issue_id, f.shipped_at, f.project_id, i.created_at AS issue_created_at
      FROM (${lastSevenDays(projectIds)}) f
      JOIN issues i ON i.id = f.issue_id
    ),
    work_start AS (
      SELECT DISTINCT ON (al.issue_id) al.issue_id, al.created_at AS started_at
      FROM activity_log al
      WHERE al.action = 'issue.statusChanged'
        AND al.payload ->> 'to' IN ('in_progress','approved')
        AND al.issue_id IN (SELECT issue_id FROM completions)
      ORDER BY al.issue_id, al.created_at ASC
    )
    SELECT c.project_id,
           avg(extract(epoch from (c.shipped_at - COALESCE(w.started_at, c.issue_created_at))) / 86400.0) AS avg_days
    FROM completions c
    LEFT JOIN work_start w ON w.issue_id = c.issue_id
    GROUP BY c.project_id
  `) as unknown as Promise<CycleRow[]>;

const readLiveRunRows = (projectIds: string[]) =>
  db
    .select({
      projectId: pipelineRuns.projectId,
      n: sql<number>`count(*)::int`,
    })
    .from(pipelineRuns)
    .where(
      and(
        inArray(pipelineRuns.projectId, projectIds),
        inArray(pipelineRuns.status, ['running', 'paused']),
      ),
    )
    .groupBy(pipelineRuns.projectId);

const readRunnerRows = (projectIds: string[]) =>
  db
    .select({
      projectId: runners.projectId,
      n: sql<number>`(count(*) FILTER (WHERE ${runners.status} = 'online'))::int`,
      // Every runner, so the band reads "online/total" as Overview does (ISS-1229 r25).
      total: sql<number>`count(*)::int`,
    })
    .from(runners)
    .where(inArray(runners.projectId, projectIds))
    .groupBy(runners.projectId);

export type SpendRow = { project_id: string; spend: number };

const readSpendRows = (projectIds: string[]) =>
  db.execute(sql`
    SELECT project_id, COALESCE(SUM(cost_usd), 0)::float AS spend
    FROM pipeline_run_step_durations
    WHERE project_id IN (${idList(projectIds)})
      AND started_at >= now() - interval '24 hours'
    GROUP BY project_id
  `) as unknown as Promise<SpendRow[]>;

const readMemberRows = (projectIds: string[]) =>
  db
    .select({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      displayName: users.displayName,
      joinedAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(inArray(projectMembers.projectId, projectIds))
    .orderBy(projectMembers.projectId, projectMembers.createdAt);

const readIssueActivityRows = (projectIds: string[]) =>
  db
    .select({
      projectId: issues.projectId,
      lastAt: sql<string | null>`max(${issues.updatedAt})`,
    })
    .from(issues)
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId);

const readRunActivityRows = (projectIds: string[]) =>
  db
    .select({
      projectId: pipelineRuns.projectId,
      lastAt: sql<string | null>`max(${pipelineRuns.updatedAt})`,
    })
    .from(pipelineRuns)
    .where(inArray(pipelineRuns.projectId, projectIds))
    .groupBy(pipelineRuns.projectId);

export type StuckIssueRow = {
  projectId: string;
  id: string;
  issSeq: number;
  issuePrefix: string | null;
  title: string;
  /** The most specific reason a standing notice gives for it (`STUCK_NOTICES`), told to the reader. */
  kind: StuckIssueKind;
  /** `waiting_on_others` only: the person the park waits for. */
  owedBy: string | null;
  /** How many issues of the project a notice stands for, beside the first `STUCK_ISSUES_LISTED`. */
  total: number;
  /** The same issues counted once each, by that reason, so the kinds add up to `total` (ISS-1229 r14). */
  byKind: Partial<Record<StuckIssueKind, number>>;
};

export const STUCK_ISSUES_LISTED = 5;

/**
 * Issues with a stuck-issue notice standing, longest-standing first, each once under its most specific
 * reason; an issue the reader's failed jobs list is counted there, never here too (ISS-1229 r15).
 */
const readStuckIssueRows = (projectIds: string[], readerId: string) =>
  db.execute(sql`
    WITH stuck AS (
      SELECT n.project_id, i.id, i.iss_seq, p.issue_prefix, i.title, n.created_at,
             ${readerStuckKindSql(sql`n.resolution_key`, sql`i.id`, readerId)} AS kind,
             ${stuckRankSql(sql`n.resolution_key`)} AS rank
        FROM notifications n
        JOIN issues i ON i.id = n.issue_id
        JOIN projects p ON p.id = i.project_id
       WHERE n.type = 'issue_stranded'
         AND n.state = 'firing'
         AND n.resolved_at IS NULL
         AND n.project_id IN (${idList(projectIds)})
         AND NOT EXISTS (SELECT 1 FROM issues WHERE issues.id = i.id AND ${heldAsFailedJobWhere(readerId)})
    ), first_notice AS (
      SELECT DISTINCT ON (project_id, id) project_id, id, iss_seq, issue_prefix, title, created_at, kind
        FROM stuck
       ORDER BY project_id, id, rank, created_at
    ), by_kind AS (
      SELECT project_id, jsonb_object_agg(kind, n) AS "byKind"
        FROM (SELECT project_id, kind, count(*)::int AS n FROM first_notice GROUP BY project_id, kind) k
       GROUP BY project_id
    )
    SELECT "projectId", id, "issSeq", "issuePrefix", title, kind, total::int AS total, "byKind",
           CASE WHEN kind = 'waiting_on_others' THEN ${parkOwerNameSql(sql`ranked.id`)} END AS "owedBy" FROM (
      SELECT f.project_id AS "projectId", f.id, f.iss_seq AS "issSeq", f.issue_prefix AS "issuePrefix",
             f.title, f.kind, b."byKind",
             count(*) OVER (PARTITION BY f.project_id) AS total,
             row_number() OVER (PARTITION BY f.project_id ORDER BY f.created_at, f.id) AS rank
        FROM first_notice f
        JOIN by_kind b ON b.project_id = f.project_id
    ) ranked
     WHERE rank <= ${STUCK_ISSUES_LISTED}
     ORDER BY "projectId", rank
  `) as unknown as Promise<StuckIssueRow[]>;

/**
 * Run the twelve reads concurrently under the module bound.
 *
 * The array order is load-bearing for the unit test's mock, which answers each
 * awaited query with the next row-set from a queue: the limiter starts parked
 * tasks in the order they asked, so the nth read still reads the nth row-set.
 */
export async function readHealthAggregates(projectIds: string[], readerId: string) {
  const run = healthReadLimiter.run.bind(healthReadLimiter);
  const [
    statusRows,
    blockerRowsAll,
    throughputRows,
    cycleRows,
    liveRunRows,
    runnerRows,
    spendRows,
    memberRows,
    issueActivityRows,
    runActivityRows,
    liveSessionRows,
    stuckIssueRows,
  ] = await Promise.all([
    run(() => readStatusRows(projectIds)),
    run(() => readBlockerRows(projectIds, readerId)),
    run(() => readThroughputRows(projectIds)),
    run(() => readCycleRows(projectIds)),
    run(() => readLiveRunRows(projectIds)),
    run(() => readRunnerRows(projectIds)),
    run(() => readSpendRows(projectIds)),
    run(() => readMemberRows(projectIds)),
    run(() => readIssueActivityRows(projectIds)),
    run(() => readRunActivityRows(projectIds)),
    run(() => readLiveSessionCounts(projectIds)),
    run(() => readStuckIssueRows(projectIds, readerId)),
  ]);

  return {
    statusRows,
    blockerRowsAll,
    throughputRows,
    cycleRows,
    liveRunRows,
    runnerRows,
    spendRows,
    memberRows,
    issueActivityRows,
    runActivityRows,
    liveSessionRows,
    stuckIssueRows,
  };
}
