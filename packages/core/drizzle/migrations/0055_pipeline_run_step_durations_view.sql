-- ISS-104 — analytics view: one row per completed pipeline step.
-- A "step" is a single job under a pipeline_run (jobs.type ∈ jobTypes).
-- duration_seconds = finished_at - started_at. cost_usd is the sum of
-- estimated_cost over usage_records linked to the job's agent_session.
-- Reversible: plain view, no triggers, no data migration.
-- To roll back: DROP VIEW pipeline_run_step_durations;

CREATE OR REPLACE VIEW "pipeline_run_step_durations" AS
SELECT
  j.pipeline_run_id                                                          AS run_id,
  r.issue_id                                                                 AS issue_id,
  r.project_id                                                               AS project_id,
  j.type                                                                     AS step,
  j.started_at                                                               AS started_at,
  j.finished_at                                                              AS finished_at,
  EXTRACT(EPOCH FROM (j.finished_at - j.started_at))::float                  AS duration_seconds,
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
WHERE j.started_at IS NOT NULL
  AND j.finished_at IS NOT NULL;
