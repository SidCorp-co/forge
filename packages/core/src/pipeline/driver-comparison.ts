// The comparison phase 5 has to answer (agent-driven pipeline).
//
// Two drivers now run side by side on one fleet, and the decision between them
// is not a matter of taste: the staged path is already paid for, so autonomous
// has to win on both of the north-star metrics or it does not ship. A tie is a
// loss. That is only a decision anyone can make if the two numbers are
// computed the same way for both, from the same rows, on demand — not
// assembled by hand from a dashboard at the end.
//
//   ① request → running: how long an issue waits between being filed and a
//     session actually starting on it.
//   ② interventions per issue closed: how often a human had to reach in.
//
// Both are per PROJECT, and each project's `mode` says which driver produced
// them. Grouping by mode across projects would compare repositories, not
// drivers.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface DriverComparisonRow {
  projectId: string;
  mode: string;
  issuesClosed: number;
  /** `dropped` issues, reported apart: they closed without work happening. */
  issuesDropped: number;
  interventions: number;
  interventionsPerIssueClosed: number | null;
  medianRequestToRunningSeconds: number | null;
  p95RequestToRunningSeconds: number | null;
}

type Raw = {
  project_id: string;
  mode: string | null;
  issues_closed: number | string;
  issues_dropped: number | string;
  interventions: number | string;
  median_request_to_running: number | string | null;
  p95_request_to_running: number | string | null;
};

// cm:guard both metrics are scoped to the issues that CLOSED in the window, not to the window's events — counting every intervention in the period against only the issues that finished in it inflates whichever driver happens to have long-running work open at the boundary
// cm:edge contract -> packages/core/drizzle/migrations/0117_intervention_events_view.sql — reads that view's project_id/issue_id/occurred_at; it is the only definition of what counts as a human reaching in
export async function driverComparison(args: {
  days: number;
  projectIds: readonly string[];
}): Promise<DriverComparisonRow[]> {
  if (args.projectIds.length === 0) return [];
  const rows = await db.execute<Raw>(sql`
    WITH scope AS (
      SELECT i.id, i.project_id, i.created_at, i.status
      FROM issues i
      WHERE i.project_id IN ${args.projectIds}
        AND i.status IN ('closed', 'dropped')
        AND i.updated_at >= now() - (${args.days}::int * interval '1 day')
    ), first_run AS (
      SELECT j.issue_id, MIN(COALESCE(s.started_at, j.dispatched_at)) AS started_at
      FROM jobs j
      LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
      WHERE j.issue_id IN (SELECT id FROM scope)
      GROUP BY j.issue_id
    ), waits AS (
      SELECT sc.project_id,
             EXTRACT(EPOCH FROM (fr.started_at - sc.created_at))::float AS wait_seconds
      FROM scope sc
      JOIN first_run fr ON fr.issue_id = sc.id
      WHERE fr.started_at IS NOT NULL AND fr.started_at >= sc.created_at
    ), touches AS (
      SELECT sc.project_id, count(*)::int AS n
      FROM issue_intervention_events e
      JOIN scope sc ON sc.id = e.issue_id
      GROUP BY sc.project_id
    )
    SELECT
      sc.project_id                                                     AS project_id,
      p.agent_config->'pipelineConfig'->>'mode'                         AS mode,
      count(*) FILTER (WHERE sc.status = 'closed')::int                 AS issues_closed,
      count(*) FILTER (WHERE sc.status = 'dropped')::int                AS issues_dropped,
      COALESCE(MAX(t.n), 0)                                             AS interventions,
      (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY w.wait_seconds)
         FROM waits w WHERE w.project_id = sc.project_id)               AS median_request_to_running,
      (SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY w.wait_seconds)
         FROM waits w WHERE w.project_id = sc.project_id)               AS p95_request_to_running
    FROM scope sc
    JOIN projects p ON p.id = sc.project_id
    LEFT JOIN touches t ON t.project_id = sc.project_id
    GROUP BY sc.project_id, p.agent_config
    ORDER BY sc.project_id
  `);

  return [...rows].map((r) => {
    const closed = Number(r.issues_closed);
    const interventions = Number(r.interventions);
    return {
      projectId: r.project_id,
      mode: r.mode ?? 'staged',
      issuesClosed: closed,
      issuesDropped: Number(r.issues_dropped),
      interventions,
      // cm:guard NULL, never 0, when nothing closed — a project with no closed issues and no interventions would otherwise report a perfect score and win the comparison by having done nothing
      interventionsPerIssueClosed: closed > 0 ? interventions / closed : null,
      medianRequestToRunningSeconds: numeric(r.median_request_to_running),
      p95RequestToRunningSeconds: numeric(r.p95_request_to_running),
    };
  });
}

function numeric(v: number | string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
