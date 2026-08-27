-- The step-duration view, rebuilt on `phase_journal` (agent-driven pipeline, 2c).
--
-- `pipeline_run_step_durations` reads `jobs`, so it can only see work the
-- staged driver shaped as one job per step. An autonomous run is one job for
-- the whole issue, which that view reports as a single span with no interior —
-- every per-step number the dashboards, the MTD budget gate and the metrics
-- MCP tools draw would quietly become one bar per issue.
--
-- This view reads the journal instead, where a phase is a phase whichever
-- driver declared it. Same ten columns in the same order, plus `attempt` and
-- `source` appended, so a consumer can be pointed at it without rewriting its
-- SELECT.
--
-- Semantics are copied deliberately, not reinvented — the point is that on
-- staged data the two agree row for row (tests/integration/step-durations-
-- parity-e2e.test.ts asserts EXCEPT in both directions):
--   * duration_seconds only for a successful, non-inverted span. `outcome='ok'`
--     is the journal's spelling of `jobs.status='done'`; `failed` and
--     `abandoned` yield NULL exactly as `failed`/`cancelled` do there.
--   * cost_usd sums usage_records for EVERY row regardless of outcome, because
--     tokens are billed regardless of outcome and the budget gate must keep
--     counting failed spend (see 0128's crux note).
--   * issue_id comes from the run, matching 0177. The backfill writes the run's
--     issue onto each row for this reason.
--
-- device_id / model_used stay on `jobs`, so they are joined back through
-- job_id. An autonomous phase with no job row reports NULL for both rather
-- than dropping the row — a phase that happened is still a phase.
--
-- Roll back: DROP VIEW "phase_step_durations". Nothing reads it yet;
-- `pipeline_run_step_durations` is untouched and remains the live view.

CREATE OR REPLACE VIEW "phase_step_durations" AS
SELECT
  pj.run_id                                                                  AS run_id,
  pj.issue_id                                                                AS issue_id,
  pj.project_id                                                              AS project_id,
  pj.phase                                                                   AS step,
  pj.started_at                                                              AS started_at,
  pj.ended_at                                                                AS finished_at,
  CASE
    WHEN pj.outcome = 'ok'
     AND pj.ended_at >= pj.started_at
    THEN EXTRACT(EPOCH FROM (pj.ended_at - pj.started_at))::float
    ELSE NULL
  END                                                                        AS duration_seconds,
  COALESCE(
    (
      SELECT SUM(ur.estimated_cost)::float
      FROM usage_records ur
      WHERE ur.session_id = pj.agent_session_id::text
    ),
    0
  )                                                                          AS cost_usd,
  j.device_id                                                                AS device_id,
  j.model_used                                                               AS model_used,
  pj.attempt                                                                 AS attempt,
  pj.source                                                                  AS source
FROM phase_journal pj
LEFT JOIN jobs j ON j.id = pj.job_id
WHERE pj.ended_at IS NOT NULL;
