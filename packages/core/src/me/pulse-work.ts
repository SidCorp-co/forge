import { and, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { ageSeconds, emptyBuckets, foldBuckets } from './pulse-folds.js';
import { idList } from './pulse-sql.js';
import {
  PULSE_HUMAN_BLOCKED_STATUSES,
  PULSE_LIVE_JOB_STATUSES,
  type PulseIssueIdentity,
  type PulseProjectIdentity,
  type PulseProjectRow,
  type PulseThresholds,
  type PulseWork,
} from './pulse-types.js';

const LIVE = [...PULSE_LIVE_JOB_STATUSES];

/**
 * Issues the tracker calls in flight that nothing is working.
 */
// cm:guard the idle clock falls back to `issues.updated_at` where the issue has NEVER carried a job: comparing against a null max drops exactly the strongest case, an `in_progress` row nothing ever dispatched (ISS-988 criterion 12).
// cm:guard a job counts for this issue when EITHER `jobs.issue_id` names it or its run does — `jobs.issue_id` is nullable and carries `ON DELETE SET NULL`, so reading it alone lets a live job go unseen and reports a worked issue as abandoned, which is the precise inverse of what this figure is for. Both the anti-join and the idle clock read the same pair, or the two disagree about which jobs exist.
// cm:guard ISS-1022 — that pair is TWO UNION ALL arms and never one `OR`, and the rewrite is what makes it affordable: as a single disjunction over a LEFT JOIN the planner can use neither index and re-read the whole of `jobs` and `pipeline_runs` per issue (measured on beta: a Seq Scan of 31,198 jobs and 7,477 runs, once per candidate). Each arm is served by its own index — `jobs_issue_id_idx` for the direct one, `pipeline_runs_issue_idx` with `jobs_pipeline_run_idx` for the run's. The arms may return the same job twice where both name this issue; that is harmless because the only things read off them are `max()` and `EXISTS`, and it is why this must never become a count of rows.
// cm:guard the staleness threshold is applied in SQL and the row set is capped, but `total` and the per-project counts are computed BEFORE the cap, over every stale issue: `PulseCapped` documents `total` as the count and `shown` as a sample, so capping first would be the truncation-as-truth defect ISS-988 criterion 46 refuses.
async function selectAbandoned(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<{ total: number; shown: PulseIssueIdentity[]; byProject: Map<string, number> }> {
  const [row] = (await db.execute(sql`
    WITH stale AS (
      SELECT i.id, i.iss_seq, i.title, i.status, i.project_id,
             p.slug AS project_slug, p.issue_prefix,
             coalesce(
               (SELECT max(seen) FROM (
                  SELECT max(coalesce(j.finished_at, j.acked_at, j.dispatched_at, j.queued_at)) AS seen
                  FROM jobs j WHERE j.issue_id = i.id
                  UNION ALL
                  SELECT max(coalesce(j.finished_at, j.acked_at, j.dispatched_at, j.queued_at))
                  FROM jobs j JOIN pipeline_runs r ON r.id = j.pipeline_run_id
                  WHERE r.issue_id = i.id
                ) arms),
               i.updated_at
             ) AS idle_since
      FROM issues i
      JOIN projects p ON p.id = i.project_id
      WHERE i.project_id IN (${idList(projectIds)})
        AND i.status = 'in_progress'
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.issue_id = i.id AND j.status IN (${idList(LIVE)})
          UNION ALL
          SELECT 1 FROM jobs j JOIN pipeline_runs r ON r.id = j.pipeline_run_id
          WHERE r.issue_id = i.id AND j.status IN (${idList(LIVE)})
        )
    -- cm:guard the cutoff comes from the CALLER's now and not from the database's, because
    -- the age this read reports is measured against that same value in ageSeconds below: a
    -- row the SQL called stale against one clock and the fold ages against another is a row
    -- whose reported age can disagree with the reason it was selected. That now is injectable
    -- so the integration suite can place a fixture either side of the threshold deliberately.
    -- The ISO text is cast rather than bound as a Date, which postgres-js refuses (ISS-267).
    ), aged AS (
      SELECT * FROM stale
      WHERE idle_since < ${now.toISOString()}::timestamptz
                         - (${thresholds.abandonedIssueSeconds}::int * interval '1 second')
    )
    SELECT
      (SELECT count(*)::int FROM aged) AS total,
      (SELECT coalesce(jsonb_object_agg(project_id, n), '{}'::jsonb)
         FROM (SELECT project_id, count(*)::int AS n FROM aged GROUP BY project_id) g) AS by_project,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.idle_since ASC), '[]'::jsonb)
         FROM (SELECT * FROM aged ORDER BY idle_since ASC LIMIT ${thresholds.identityCap}) t) AS shown
  `)) as unknown as Array<{
    total: number;
    by_project: Record<string, number>;
    shown: Array<{
      id: string;
      iss_seq: number;
      title: string;
      status: string;
      project_slug: string;
      issue_prefix: string | null;
      idle_since: string;
    }>;
  }>;

  const byProject = new Map<string, number>();
  for (const [projectId, n] of Object.entries(row?.by_project ?? {})) {
    byProject.set(projectId, Number(n));
  }

  return {
    total: Number(row?.total ?? 0),
    byProject,
    shown: (row?.shown ?? []).map((r) => ({
      documentId: r.id,
      issueRef: formatIssueRef(r.issue_prefix, r.iss_seq),
      title: r.title,
      status: r.status,
      projectSlug: r.project_slug,
      ageSeconds: ageSeconds(r.idle_since, now) ?? 0,
    })),
  };
}

// cm:guard `total` counts every waiting issue and `shown` is capped, computed IN THAT ORDER: the old read returned the whole set and let JS cap it, so a queue of 400 issues came back as 400 rows to show 20. Reversing the order makes `total` the cap, which is the truncation-as-truth defect `PulseCapped` names (ISS-1022).
// cm:guard the cutoff is the caller's injected `now` and NOT the database's `now()`, the same clock `ageSeconds` below ages the row against: read against two clocks a row can be selected as waiting and then reported with an age under the threshold that selected it. This read used `now()` before ISS-1022 while its sibling `selectAbandoned` used the injected value, so the two halves of one screen disagreed whenever a test or a caller moved the clock.
async function selectReleaseWaiting(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<{ total: number; shown: PulseIssueIdentity[] }> {
  const [row] = (await db.execute(sql`
    WITH waiting AS (
      SELECT i.id, i.iss_seq, i.title, i.status, i.updated_at,
             p.slug AS project_slug, p.issue_prefix
      FROM issues i JOIN projects p ON p.id = i.project_id
      WHERE i.project_id IN (${idList(projectIds)})
        AND i.status IN ('awaiting_release', 'releasing')
        AND i.updated_at < ${now.toISOString()}::timestamptz
                           - (${thresholds.releaseWaitingSeconds}::int * interval '1 second')
    )
    SELECT
      (SELECT count(*)::int FROM waiting) AS total,
      (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.updated_at ASC), '[]'::jsonb)
         FROM (SELECT * FROM waiting ORDER BY updated_at ASC LIMIT ${thresholds.identityCap}) t) AS shown
  `)) as unknown as Array<{
    total: number;
    shown: Array<{
      id: string;
      iss_seq: number;
      title: string;
      status: string;
      updated_at: string;
      project_slug: string;
      issue_prefix: string | null;
    }>;
  }>;
  return {
    total: Number(row?.total ?? 0),
    shown: (row?.shown ?? []).map((r) => ({
      documentId: r.id,
      issueRef: formatIssueRef(r.issue_prefix, r.iss_seq),
      title: r.title,
      status: r.status,
      projectSlug: r.project_slug,
      ageSeconds: ageSeconds(r.updated_at, now) ?? 0,
    })),
  };
}

async function selectHumanBlockedAges(
  projectIds: string[],
  cap: number,
  now: Date,
): Promise<number[]> {
  const rows = await db
    .select({ updatedAt: issues.updatedAt })
    .from(issues)
    .where(
      and(
        inArray(issues.projectId, projectIds),
        inArray(issues.status, [...PULSE_HUMAN_BLOCKED_STATUSES]),
      ),
    )
    .orderBy(sql`${issues.updatedAt} ASC`)
    .limit(cap * 10);
  return rows.map((r) => ageSeconds(r.updatedAt, now) ?? 0);
}

async function selectProjectRuns(projectIds: string[]) {
  const rows = (await db.execute(sql`
    SELECT p.id, p.slug, p.name,
           (SELECT max(r.started_at) FROM pipeline_runs r
             WHERE r.project_id = p.id AND r.kind = 'issue') AS last_issue_run_at,
           (SELECT count(*)::int FROM pipeline_runs r
             WHERE r.project_id = p.id AND r.status IN ('running','paused')
               AND NOT EXISTS (
                 SELECT 1 FROM jobs j WHERE j.pipeline_run_id = r.id AND j.status IN (${idList(LIVE)})
               )) AS stuck_runs
    FROM projects p
    WHERE p.id IN (${idList(projectIds)})
  `)) as unknown as Array<{
    id: string;
    slug: string;
    name: string;
    last_issue_run_at: string | null;
    stuck_runs: number;
  }>;
  return rows;
}

const asIdentity = (r: PulseProjectRow): PulseProjectIdentity => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  backlog: r.open + r.inProgress + r.awaitingRelease + r.humanBlocked,
  lastIssueRunAt: r.lastIssueRunAt,
});

export async function readPulseWork(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<PulseWork> {
  const [statusRows, abandoned, releaseWaiting, humanBlockedAges, runRows] = await Promise.all([
    db
      .select({ projectId: issues.projectId, status: issues.status, n: sql<number>`count(*)::int` })
      .from(issues)
      .where(inArray(issues.projectId, projectIds))
      .groupBy(issues.projectId, issues.status),
    selectAbandoned(projectIds, thresholds, now),
    selectReleaseWaiting(projectIds, thresholds, now),
    selectHumanBlockedAges(projectIds, thresholds.identityCap, now),
    selectProjectRuns(projectIds),
  ]);

  const { total, byProject } = foldBuckets(
    statusRows.map((r) => ({ projectId: r.projectId, status: r.status, n: Number(r.n) })),
  );

  const perProject: PulseProjectRow[] = runRows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    ...(byProject.get(r.id) ?? emptyBuckets()),
    stuckRuns: Number(r.stuck_runs),
    abandonedIssues: abandoned.byProject.get(r.id) ?? 0,
    lastIssueRunAt: r.last_issue_run_at,
  }));

  const backlogged = perProject.filter(
    (p) => p.open + p.inProgress + p.awaitingRelease + p.humanBlocked > 0,
  );
  const neverRan = backlogged.filter((p) => p.lastIssueRunAt === null);
  const silent = backlogged.filter(
    (p) =>
      p.lastIssueRunAt !== null &&
      (ageSeconds(p.lastIssueRunAt, now) ?? 0) > thresholds.projectSilenceSeconds,
  );

  return {
    buckets: total,
    abandoned: { total: abandoned.total, shown: abandoned.shown },
    releaseWaiting,
    silentProjects: {
      total: silent.length,
      shown: silent.slice(0, thresholds.identityCap).map(asIdentity),
    },
    neverRanProjects: {
      total: neverRan.length,
      shown: neverRan.slice(0, thresholds.identityCap).map(asIdentity),
    },
    humanBlockedAges,
    perProject,
  };
}
