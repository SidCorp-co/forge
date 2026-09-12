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
const SHIPPED_EVIDENCE = sql`(
  EXISTS (
    SELECT 1 FROM activity_log a
    WHERE a.issue_id = i.id AND a.action = 'issue.statusChanged'
      AND a.payload ->> 'to' = ${BASE_MERGE_STATE}
  )
  OR (i.merged_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM activity_log a
    WHERE a.issue_id = i.id AND a.action = 'issue.statusChanged'
      AND a.payload ->> 'to' = 'closed' AND a.created_at = i.merged_at
  ))
)`;

async function readFinished(scope: ReturnType<typeof idList>) {
  const [row] = (await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'closed' AND ${SHIPPED_EVIDENCE})::int AS merged,
      count(*) FILTER (WHERE status = 'closed' AND NOT ${SHIPPED_EVIDENCE})::int AS closed_unmerged,
      count(*) FILTER (WHERE status = 'dropped')::int AS dropped,
      count(*) FILTER (WHERE reopen_count > 0)::int AS reopened_issues,
      coalesce(sum(reopen_count), 0)::int AS reopen_events
    FROM issues i WHERE i.project_id IN (${scope})
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
