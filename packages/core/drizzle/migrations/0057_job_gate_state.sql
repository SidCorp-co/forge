-- ISS-XXX: job-level gate state + drop dead jobs.started_at column.
--
-- Why: dispatcher gate skips (issue_busy, waiting_on_dep, project_full,
-- runner_full, manual_hold) were previously mirrored onto
-- `agent_sessions.failure_reason`. That signal is unreliable for queue
-- watchdogs because a newly enqueued job has no session yet — the dispatcher
-- creates one only on the first dispatch attempt. queued-watchdog therefore
-- could not distinguish "queued because gate skipped recently" from "queued
-- because pg-boss desync".
--
-- Fix: track gate state on the `jobs` row directly. Always written, always
-- present, watchdogs read the canonical signal.
--
-- Also drops `jobs.started_at` — no code path writes it (workers stream
-- progress through `job_events`, which flip `agent_sessions.last_heartbeat_at`).
-- The column was a watchdog signal for a different design that never landed;
-- the post-fix stuck-watcher already migrated to session heartbeat.

-- The pipeline_run_step_durations view (migration 0055) referenced
-- jobs.started_at — a column that was always NULL in practice, so the view
-- produced zero rows. Drop + recreate the view using
-- agent_sessions.started_at (set reliably by jobs/events-routes.ts on the
-- worker's first event), falling back to jobs.dispatched_at for legacy
-- rows with NULL agent_session_id.
DROP VIEW IF EXISTS "pipeline_run_step_durations";

ALTER TABLE "jobs" DROP COLUMN IF EXISTS "started_at";

ALTER TABLE "jobs" ADD COLUMN "gate_reason" text;
ALTER TABLE "jobs" ADD COLUMN "gate_at" timestamp with time zone;
ALTER TABLE "jobs" ADD COLUMN "gate_metadata" jsonb;

CREATE INDEX IF NOT EXISTS "jobs_gate_at_idx" ON "jobs" ("gate_at")
  WHERE "gate_reason" IS NOT NULL;

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
WHERE j.finished_at IS NOT NULL
  AND (s.started_at IS NOT NULL OR j.dispatched_at IS NOT NULL);

-- Hạ runner cap claude-code 2 → 1. Empirical: a desktop device with one
-- Tauri runner spawns Claude CLI processes serially in practice; the cap=2
-- was aspirational and caused dispatcher to over-dispatch a 2nd job that
-- sat dispatched without a heartbeat (now correctly skipped by post-fix
-- stuck-watcher, but still wasted a slot in the gate accounting).
UPDATE runners
   SET capabilities = jsonb_set(
         COALESCE(capabilities, '{}'::jsonb),
         '{maxConcurrent}',
         '1'::jsonb,
         true)
 WHERE type = 'claude-code';
