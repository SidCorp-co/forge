-- Per-state runner pools make "which box / which model ran this step" a
-- question the analytics surface must be able to answer. Before this, the view
-- exposed step/duration/cost only, so a stage pinned to a pool of N boxes
-- produced numbers that could not be split per box — the comparison the pool
-- exists to enable was unreadable.
--
-- device_id + model_used are APPENDED. `CREATE OR REPLACE VIEW` may only add
-- columns at the END of the select list, and every existing consumer
-- (jobs/budget-check.ts, metrics/queries.ts, mcp/tools/forge-metrics.ts,
-- projects/health-routes.ts, pipeline/analytics-routes.ts) names its columns
-- explicitly, so appending is transparent to all of them.
--
-- Row set and the duration/cost semantics of 0128 are UNCHANGED: duration_seconds
-- still yields a value only for a `done`, non-inverted span, and cost_usd still
-- sums over every finished job so the MTD budget gate keeps counting failed and
-- cancelled spend.
--
-- Roll back: re-create the 0128 view (drop the two trailing columns).

CREATE OR REPLACE VIEW "pipeline_run_step_durations" AS
SELECT
  j.pipeline_run_id                                                          AS run_id,
  r.issue_id                                                                 AS issue_id,
  r.project_id                                                               AS project_id,
  j.type                                                                     AS step,
  COALESCE(s.started_at, j.dispatched_at)                                    AS started_at,
  j.finished_at                                                              AS finished_at,
  CASE
    WHEN j.status = 'done'
     AND j.finished_at >= COALESCE(s.started_at, j.dispatched_at)
    THEN EXTRACT(EPOCH FROM (j.finished_at - COALESCE(s.started_at, j.dispatched_at)))::float
    ELSE NULL
  END                                                                        AS duration_seconds,
  COALESCE(
    (
      SELECT SUM(ur.estimated_cost)::float
      FROM usage_records ur
      WHERE ur.session_id = j.agent_session_id::text
    ),
    0
  )                                                                          AS cost_usd,
  j.device_id                                                                AS device_id,
  j.model_used                                                               AS model_used
FROM jobs j
INNER JOIN pipeline_runs r ON r.id = j.pipeline_run_id
LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
WHERE j.finished_at IS NOT NULL
  AND (s.started_at IS NOT NULL OR j.dispatched_at IS NOT NULL);
