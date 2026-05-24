-- W2.2.1 — extend pipeline_run_step_durations with cache-token columns so the
-- cost analytics endpoints can compute prompt-cache hit-rate without a second
-- pass over usage_records. Rewrites the 0055 view in place; same name, same
-- primary semantics. Roll back: DROP VIEW pipeline_run_step_durations;
--
-- Outlier classification (p95) is NOT baked into the view — threshold depends
-- on the query window (days / step) and is computed per-request in SQL.

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
  )                                                                          AS cost_usd,
  COALESCE(
    (
      SELECT SUM(ur.cache_read_tokens)::bigint
      FROM usage_records ur
      WHERE ur.session_id = j.agent_session_id::text
    ),
    0
  )                                                                          AS cache_read_tokens,
  COALESCE(
    (
      SELECT SUM(ur.input_tokens + ur.cache_read_tokens)::bigint
      FROM usage_records ur
      WHERE ur.session_id = j.agent_session_id::text
    ),
    0
  )                                                                          AS total_input_tokens,
  (
    SELECT
      CASE
        WHEN SUM(ur.input_tokens + ur.cache_read_tokens) > 0
          THEN SUM(ur.cache_read_tokens)::float
               / NULLIF(SUM(ur.input_tokens + ur.cache_read_tokens), 0)::float
        ELSE NULL
      END
    FROM usage_records ur
    WHERE ur.session_id = j.agent_session_id::text
  )                                                                          AS cache_hit_rate
FROM jobs j
INNER JOIN pipeline_runs r ON r.id = j.pipeline_run_id
WHERE j.started_at IS NOT NULL
  AND j.finished_at IS NOT NULL;
