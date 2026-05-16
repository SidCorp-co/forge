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

ALTER TABLE "jobs" DROP COLUMN IF EXISTS "started_at";

ALTER TABLE "jobs" ADD COLUMN "gate_reason" text;
ALTER TABLE "jobs" ADD COLUMN "gate_at" timestamp with time zone;
ALTER TABLE "jobs" ADD COLUMN "gate_metadata" jsonb;

CREATE INDEX IF NOT EXISTS "jobs_gate_at_idx" ON "jobs" ("gate_at")
  WHERE "gate_reason" IS NOT NULL;

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
