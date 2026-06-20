-- ISS-516: kill negative step-duration analytics.
--
-- Symptom: forge_metrics_project_step_durations returned physically-impossible
-- NEGATIVE p50/avg (e.g. test p50 -63.8s, avg -1824s) because the
-- pipeline_run_step_durations view aggregated EVERY job span — including
-- cancelled / failed / zero-ack-reaped jobs whose finished_at is stamped by
-- the cleanup path BEFORE the span start. Those inverted spans produced
-- duration_seconds < 0, dragging percentile/avg below zero.
--
-- Fix (two guards):
--   1. WHERE j.status = 'done' — measure only successfully-completed steps.
--      `failed` is EXCLUDED by decision (it is exactly the contamination; a
--      separate failed-duration column is out of scope). cancelled / reaped
--      jobs are non-`done` and therefore excluded too.
--   2. AND j.finished_at >= COALESCE(s.started_at, j.dispatched_at) — belt &
--      suspenders against clock skew / COALESCE edge cases. Inverted spans are
--      EXCLUDED, not clamped to 0 (clamping injects fake zero rows that still
--      drag p50/avg down).
--
-- Shape: this is the migration-0057 view shape, NOT 0055 and NOT 0075.
--   * jobs.started_at was created in 0003 and DROPPED in 0057; the view derives
--     the step start from COALESCE(agent_sessions.started_at, jobs.dispatched_at).
--   * 0075_pipeline_run_step_cost_extended.sql is ORPHANED — never registered in
--     meta/_journal.json, so it never ran anywhere (and references the dropped
--     j.started_at). It is deleted in this commit. The cache-token columns it
--     claimed never existed on the live view; cache_hit_rate is computed from
--     usage_records in src/metrics/queries.ts. The 8-column contract is preserved
--     here (run_id, issue_id, project_id, step, started_at, finished_at,
--     duration_seconds, cost_usd) so REST + dashboard + Grafana consumers are
--     untouched.
--
-- Roll back: re-create the 0057 view (drop the status / inverted-span guards).

CREATE OR REPLACE VIEW "pipeline_run_step_durations" AS
SELECT
  j.pipeline_run_id                                                          AS run_id,
  r.issue_id                                                                 AS issue_id,
  r.project_id                                                               AS project_id,
  j.type                                                                     AS step,
  COALESCE(s.started_at, j.dispatched_at)                                    AS started_at,
  j.finished_at                                                              AS finished_at,
  EXTRACT(EPOCH FROM (j.finished_at - COALESCE(s.started_at, j.dispatched_at)))::float AS duration_seconds,
  COALESCE(
    (
      SELECT SUM(ur.estimated_cost)::float
      FROM usage_records ur
      WHERE ur.session_id = j.agent_session_id::text
    ),
    0
  )                                                                          AS cost_usd
FROM jobs j
INNER JOIN pipeline_runs r ON r.id = j.pipeline_run_id
LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
WHERE j.status = 'done'
  AND j.finished_at IS NOT NULL
  AND COALESCE(s.started_at, j.dispatched_at) IS NOT NULL
  AND j.finished_at >= COALESCE(s.started_at, j.dispatched_at);
