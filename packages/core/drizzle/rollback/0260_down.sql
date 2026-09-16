-- Undo 0260 (ISS-1015). Neither statement drops a row or a column, which is why
-- 0260 classifies as tightening rather than destructive: everything it demands
-- can be un-demanded, and nothing it deploys discards a value this does not put
-- back.
--
-- What this does NOT undo: a batch the tightened ingest route refused between
-- the deploy and the rollback was never stored, and nothing here replays it.
-- The client re-sends it.

ALTER TABLE "usage_records" DROP CONSTRAINT IF EXISTS "usage_records_session_id_uuid_chk";

-- The 0177 body, restored verbatim: cost_usd back to the correlated subquery.
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
