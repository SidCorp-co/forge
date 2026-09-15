import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { BASE_MERGE_STATE } from '../issues/merged-at.js';
import { foldLanes } from './pulse-folds.js';
import { idList } from './pulse-sql.js';
import { PULSE_QUALITY_WINDOW_DAYS, type PulseQuality } from './pulse-types.js';

const windowExpr = sql`now() - (${PULSE_QUALITY_WINDOW_DAYS}::int * interval '1 day')`;

/**
 * Finished issues split by whether anything says the code actually shipped.
 */
// cm:guard `merged_at IS NOT NULL` is NOT shipped-evidence and must never be the test here: `markMergedOnClose` stamps it on EVERY close, so the bare column degenerates to "closed" and reports never-merged work as merged — which is the one figure section 5 exists to expose (ISS-817, re-met by ISS-988).
// cm:edge lockstep -> packages/core/src/issues/progress.ts#computeProjectProgress — the same two disjuncts, and the same timestamp-identity trick for spotting the auto-stamp; a change to the evidence rule there is a change to this figure's meaning
// cm:guard the two disjuncts are decided in ONE grouped pass over `activity_log`, not as four correlated `EXISTS` per issue, and the rule is unchanged: on beta the two forms returned identical counts over 5,059 issues across 34 projects, 222.3ms against 37.2ms (ISS-1022).
// cm:guard each flag is COALESCEd to false ON ITS OWN, before the OR and before the NOT: coalescing the finished expression instead silently reclassifies an issue with no `activity_log` rows and a non-null `merged_at` from merged to unmerged, and such rows exist (`applyMergeMarker` on transitions predating the audit trail).
async function readFinished(scope: ReturnType<typeof idList>) {
  const [row] = (await db.execute(sql`
    WITH scope_issues AS (
      SELECT i.id, i.status, i.merged_at, i.reopen_count
      FROM issues i WHERE i.project_id IN (${scope})
    ), evidence AS (
      SELECT a.issue_id,
             bool_or(a.payload ->> 'to' = ${BASE_MERGE_STATE}) AS reached_merge_state,
             bool_or(a.payload ->> 'to' = 'closed' AND a.created_at = s.merged_at)
               AS stamped_by_close_itself
      FROM activity_log a
      JOIN scope_issues s ON s.id = a.issue_id
      WHERE a.action = 'issue.statusChanged'
      GROUP BY a.issue_id
    ), judged AS (
      SELECT s.status, s.reopen_count,
             (coalesce(e.reached_merge_state, false)
              OR (s.merged_at IS NOT NULL AND NOT coalesce(e.stamped_by_close_itself, false)))
               AS shipped
      FROM scope_issues s
      LEFT JOIN evidence e ON e.issue_id = s.id
    )
    SELECT
      count(*) FILTER (WHERE status = 'closed' AND shipped)::int AS merged,
      count(*) FILTER (WHERE status = 'closed' AND NOT shipped)::int AS closed_unmerged,
      count(*) FILTER (WHERE status = 'dropped')::int AS dropped,
      count(*) FILTER (WHERE reopen_count > 0)::int AS reopened_issues,
      coalesce(sum(reopen_count), 0)::int AS reopen_events
    FROM judged
  `)) as unknown as Array<{
    merged: number;
    closed_unmerged: number;
    dropped: number;
    reopened_issues: number;
    reopen_events: number;
  }>;
  return (
    row ?? {
      merged: 0,
      closed_unmerged: 0,
      dropped: 0,
      reopened_issues: 0,
      reopen_events: 0,
    }
  );
}

async function readRework(scope: ReturnType<typeof idList>) {
  const rows = (await db.execute(sql`
    SELECT type, count(*)::int AS n
    FROM jobs
    WHERE project_id IN (${scope}) AND type IN ('fix', 'code') AND queued_at >= ${windowExpr}
    GROUP BY type
  `)) as unknown as Array<{ type: string; n: number }>;
  const by = new Map(rows.map((r) => [r.type, Number(r.n)]));
  return { fix: by.get('fix') ?? 0, code: by.get('code') ?? 0 };
}

async function readLanes(scope: ReturnType<typeof idList>) {
  const rows = (await db.execute(sql`
    SELECT kind,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*)::int AS total
    FROM pipeline_runs
    WHERE project_id IN (${scope}) AND started_at >= ${windowExpr}
    GROUP BY kind
  `)) as unknown as Array<{ kind: string; failed: number; total: number }>;
  return foldLanes(
    rows.map((r) => ({ kind: r.kind, failed: Number(r.failed), total: Number(r.total) })),
  );
}

/**
 * Failed agent sessions of the window, grouped by what killed them.
 */
// cm:guard a NULL `failure_reason` becomes the row `unclassified` and is never dropped: 66% of failures carried no reason on 2026-09-12, and a grouping that skips them reports the classified third as the whole (ISS-988).
async function readSessionFailures(scope: ReturnType<typeof idList>) {
  const rows = (await db.execute(sql`
    SELECT coalesce(failure_reason, 'unclassified') AS reason, count(*)::int AS n
    FROM agent_sessions
    WHERE project_id IN (${scope}) AND status = 'failed' AND created_at >= ${windowExpr}
    GROUP BY 1 ORDER BY 2 DESC
  `)) as unknown as Array<{ reason: string; n: number }>;
  return rows.map((r) => ({ reason: r.reason, count: Number(r.n) }));
}

/** Per job type: how many ran, and how long the middle one took. */
async function readPipelineFlow(scope: ReturnType<typeof idList>) {
  const rows = (await db.execute(sql`
    SELECT type, count(*)::int AS n,
           percentile_disc(0.5) WITHIN GROUP (
             ORDER BY extract(epoch FROM (finished_at - coalesce(dispatched_at, queued_at)))
           ) AS median_seconds
    FROM jobs
    WHERE project_id IN (${scope}) AND queued_at >= ${windowExpr} AND finished_at IS NOT NULL
    GROUP BY type
  `)) as unknown as Array<{ type: string; n: number; median_seconds: string | number | null }>;
  return rows.map((r) => ({
    type: r.type,
    count: Number(r.n),
    medianSeconds:
      r.median_seconds == null ? null : Math.max(0, Math.round(Number(r.median_seconds))),
  }));
}

export async function readPulseQuality(projectIds: string[]): Promise<PulseQuality> {
  const scope = idList(projectIds);
  const [finished, rework, runFailure, sessionFailures, pipelineFlow] = await Promise.all([
    readFinished(scope),
    readRework(scope),
    readLanes(scope),
    readSessionFailures(scope),
    readPipelineFlow(scope),
  ]);

  return {
    finished: {
      merged: Number(finished.merged),
      closedUnmerged: Number(finished.closed_unmerged),
      dropped: Number(finished.dropped),
    },
    reopened: {
      issues: Number(finished.reopened_issues),
      events: Number(finished.reopen_events),
    },
    rework,
    runFailure,
    sessionFailures,
    pipelineFlow,
  };
}
