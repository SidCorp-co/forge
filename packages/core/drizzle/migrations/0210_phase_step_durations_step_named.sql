-- `step_named` — the marker that tells the two phase-name eras apart (ISS-921).
--
-- `phase_journal.phase` is free vocabulary and no gate reads it, which is
-- deliberate. Between 2026-09-02 and ISS-921 the drive prompt's worked example
-- carried the literal `phase-1`, agents copied it, and 542 rows landed named
-- `phase-0`..`phase-8`. What step each one was is not recoverable, so they are
-- NOT rewritten — inventing a name would put fiction in the one table that
-- exists to be evidence.
--
-- A boundary date cannot separate the eras: the fix is a seed, not a gate, so a
-- session on a stale plugin can still write an ordinal tomorrow and a date-based
-- reader would count it as readable. The name is self-identifying, so the marker
-- is the pattern, resolved once here rather than in every consumer's WHERE.
--
-- Appended LAST, after 0184's ten columns plus `attempt` and `source`, so the
-- shared-column parity with `pipeline_run_step_durations` is untouched
-- (tests/integration/step-durations-parity-e2e.test.ts names its columns).
--
-- Roll back: re-run 0184's body verbatim.

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
  pj.source                                                                  AS source,
  (pj.phase !~ '^phase-[0-9]+$')                                             AS step_named
FROM phase_journal pj
LEFT JOIN jobs j ON j.id = pj.job_id
WHERE pj.ended_at IS NOT NULL;
