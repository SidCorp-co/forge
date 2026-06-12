-- ISS-448 (ISS-442 C2, invariant I1) — ONE-SHOT backfill of pre-existing orphans.
--
-- Runs AFTER 0113 installs the trigger. The trigger only guards writes from now
-- on; rows that were already orphaned before it existed (the ~20 ghost-jobs class
-- — active children left stranded under a run that closed before the runs-cascade
-- in runs-cascade.ts covered the natural-close paths) need a one-time sweep.
--
-- Same terminal semantics + same failure_reason as the trigger and the C1 cascade:
--   pipeline_run terminal = completed | failed | cancelled
--   jobs           active  = queued | dispatched | running   -> cancelled
--   agent_sessions active  = idle | queued | running         -> cancelled_stale
-- failure_reason = 'orphan_under_terminal_run' on both.
--
-- SCOPED PRECISELY: the WHERE clause requires the PARENT run to be terminal, so a
-- legitimate in-flight row under a still-active (running | paused) run is NEVER
-- touched. Idempotent — a re-run finds no active rows under terminal runs left to
-- flip (the previous run already moved them to terminal), so it converges cleanly.
-- We also write a `kernel_transitions` audit row per flipped entity (source =
-- 'i1_backfill') to keep I2's audit trail complete, mirroring the trigger.
--
-- Hand-written data backfill; registered in meta/_journal.json.

-- jobs: active children under a terminal run -> cancelled
INSERT INTO "kernel_transitions"
  ("entity", "entity_id", "from_status", "to_status", "reason", "actor_type", "actor_id", "source")
SELECT 'job', j.id, j.status, 'cancelled', 'orphan_under_terminal_run', 'system', NULL, 'i1_backfill'
FROM "jobs" j
JOIN "pipeline_runs" r ON r.id = j.pipeline_run_id
WHERE j.status IN ('queued', 'dispatched', 'running')
  AND r.status IN ('completed', 'failed', 'cancelled');--> statement-breakpoint

UPDATE "jobs" j
SET status = 'cancelled',
    failure_kind = 'transient',
    failure_reason = 'orphan_under_terminal_run',
    cancellation_requested = true,
    finished_at = COALESCE(j.finished_at, now())
FROM "pipeline_runs" r
WHERE j.pipeline_run_id = r.id
  AND j.status IN ('queued', 'dispatched', 'running')
  AND r.status IN ('completed', 'failed', 'cancelled');--> statement-breakpoint

-- agent_sessions: active children under a terminal run -> cancelled_stale
INSERT INTO "kernel_transitions"
  ("entity", "entity_id", "from_status", "to_status", "reason", "actor_type", "actor_id", "source")
SELECT 'session', s.id, s.status, 'cancelled_stale', 'orphan_under_terminal_run', 'system', NULL, 'i1_backfill'
FROM "agent_sessions" s
JOIN "pipeline_runs" r ON r.id = s.pipeline_run_id
WHERE s.status IN ('idle', 'queued', 'running')
  AND r.status IN ('completed', 'failed', 'cancelled');--> statement-breakpoint

UPDATE "agent_sessions" s
SET status = 'cancelled_stale',
    failure_reason = 'orphan_under_terminal_run',
    updated_at = now()
FROM "pipeline_runs" r
WHERE s.pipeline_run_id = r.id
  AND s.status IN ('idle', 'queued', 'running')
  AND r.status IN ('completed', 'failed', 'cancelled');
