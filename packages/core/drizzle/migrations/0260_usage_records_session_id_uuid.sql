-- ISS-1015 — two statements, one purpose: let every session-scoped cost read
-- reach `usage_records` through `usage_records_session_id_idx`.
--
-- 1. THE CONSTRAINT is what makes the read side's plain text equality safe
-- rather than merely believed. `usage_records.session_id` is an
-- `agent_sessions.id` held in TEXT. Until now the rollups guarded a `::uuid`
-- cast with `session_id ~ '^[0-9a-fA-F-]{36}$'`, and neither half can use the
-- btree on the text column: measured on beta 2026-09-17, that predicate plans
-- as a Seq Scan at cost 1311.00 (32.1ms, 829 buffers, 24,084 of 24,085 rows
-- removed by filter) where plain equality plans as an Index Scan at cost 8.31
-- (0.32ms, 3 buffers). The regex was also never the guard it was credited with
-- — 36 hyphens passes it and fails the cast.
--
-- A row holding some other spelling is not an error any surface reports: it is
-- a row every cost figure silently omits. So the shape moves to where it can be
-- enforced. Validated against all 24,085 rows on beta on 2026-09-17 — every one
-- is already a canonical lowercase uuid, 0 carry uppercase hex, 0 are not
-- uuid-shaped — so this discards nothing. A database where one row does NOT fit
-- aborts this migration naming that row; because the container runs
-- `node dist/db/migrate.js && ... exec node dist/index.js`, that abort also
-- stops this container's server, so the tightened ingest route never answers a
-- request against a database this constraint has not cleared.
--
-- 2. THE VIEW keeps its column list, its column order, its row set and the
-- duration semantics of 0128/0177 exactly. Only `cost_usd` changes shape: it
-- was a correlated scalar subquery executed once per job row — 29,533 SubPlan
-- loops and 136,174 shared-buffer hits for 126ms on the whole view — and
-- becomes a LEFT JOIN onto one per-session aggregate, which reads
-- `usage_records` once whatever the outer filter. Measured on beta at this
-- head: the whole view falls to 37.3ms and 10,473 buffers. A project-filtered
-- 30-day read rises from 18.8ms to 28.3ms, because that single pass is paid
-- whether the outer query wants two job rows or every one; that is the priced
-- trade, taken because the aggregate scales with sessions (15,657) where the
-- subquery scales with job rows (29,533), and because ending the per-job
-- subquery is what this issue asks for. A LEFT JOIN LATERAL reads faster narrow
-- (16.4ms) but is still executed once per job row, so it is not the thing asked
-- for.
--
-- The LEFT JOIN cannot fan out: `session_id` is the aggregate's group key, so
-- it matches a job row at most once, and a job with a null `agent_session_id`
-- or with no usage rows still yields 0 exactly as the subquery's
-- `COALESCE(NULL, 0)` did.
--
-- Roll back: `drizzle/rollback/0260_down.sql`.

ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_session_id_uuid_chk" CHECK ("usage_records"."session_id" IS NULL OR "usage_records"."session_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

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
  COALESCE(c.cost_usd, 0)                                                    AS cost_usd,
  j.device_id                                                                AS device_id,
  j.model_used                                                               AS model_used
FROM jobs j
INNER JOIN pipeline_runs r ON r.id = j.pipeline_run_id
LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
LEFT JOIN (
  SELECT ur.session_id                    AS session_id,
         SUM(ur.estimated_cost)::float    AS cost_usd
  FROM usage_records ur
  WHERE ur.session_id IS NOT NULL
  GROUP BY ur.session_id
) c ON c.session_id = j.agent_session_id::text
WHERE j.finished_at IS NOT NULL
  AND (s.started_at IS NOT NULL OR j.dispatched_at IS NOT NULL);
