-- ISS-450 follow-up (ISS-442 C4 ⇄ C2 interaction) — re-create the I1 trigger
-- function with the v3 failure taxonomy. Hand-written; applied from
-- meta/_journal.json.
--
-- The 0113 function body assigns NEW.failure_kind := 'transient' on an
-- alarm-mode auto-cancel. After 0115 swapped jobs_failure_kind_check to the v3
-- set (code|infra|transient-cc|timeout), a future trigger fire would assign a
-- value the CHECK now rejects — turning alarm mode into an accidental
-- hard-reject with a constraint error instead of the intended auto-cancel.
-- Replace the literal with 'infra' (an orphan under a terminal run is an
-- environment/state problem, mirroring runs-cascade.ts). Everything else is
-- IDENTICAL to 0113 — same staged-rollout contract (alarm now, hard-reject at
-- the ISS-442 parent integration), same terminal semantics, same audit row.
-- Idempotent (CREATE OR REPLACE; triggers from 0113 keep pointing at the
-- function by name).

CREATE OR REPLACE FUNCTION "enforce_no_active_child_under_terminal_run"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  child_active boolean;
  prev_status text;
  terminal_status text;
BEGIN
  -- Only rows that hang off a pipeline_run can be orphaned.
  IF NEW.pipeline_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Is the incoming row in a NON-terminal (active) status for its table?
  IF TG_TABLE_NAME = 'jobs' THEN
    child_active := NEW.status IN ('queued', 'dispatched', 'running');
    terminal_status := 'cancelled';
  ELSIF TG_TABLE_NAME = 'agent_sessions' THEN
    child_active := NEW.status IN ('idle', 'queued', 'running');
    terminal_status := 'cancelled_stale';
  ELSE
    RETURN NEW; -- trigger is only ever attached to the two tables above
  END IF;

  -- Writing a terminal row is always fine (cascade / finalize path).
  IF NOT child_active THEN
    RETURN NEW;
  END IF;

  -- Single indexed PK lookup of the parent run's status.
  SELECT status INTO run_status FROM pipeline_runs WHERE id = NEW.pipeline_run_id;

  -- Parent missing or still active => legitimate in-flight row, leave untouched.
  IF run_status IS NULL OR run_status IN ('running', 'paused') THEN
    RETURN NEW;
  END IF;

  -- ===== INVARIANT I1 VIOLATION: active child under a terminal run =====
  -- PHASE 1 ALARM MODE: auto-cancel + audit + LOG (PHASE 2 will RAISE EXCEPTION
  -- here instead — see the 0113 migration header).
  prev_status := NEW.status;

  INSERT INTO "kernel_transitions"
    ("entity", "entity_id", "from_status", "to_status", "reason", "actor_type", "actor_id", "source")
  VALUES
    (CASE WHEN TG_TABLE_NAME = 'jobs' THEN 'job' ELSE 'session' END,
     NEW.id, prev_status, terminal_status, 'orphan_under_terminal_run',
     'system', NULL, 'i1_trigger');

  IF TG_TABLE_NAME = 'jobs' THEN
    NEW.status := 'cancelled';
    NEW.failure_kind := 'infra';
    NEW.failure_reason := 'orphan_under_terminal_run';
    NEW.cancellation_requested := true;
    NEW.finished_at := COALESCE(NEW.finished_at, now());
  ELSE
    NEW.status := 'cancelled_stale';
    NEW.failure_reason := 'orphan_under_terminal_run';
    NEW.updated_at := now();
  END IF;

  RAISE LOG 'I1 alarm: %=% (was %) auto-cancelled under terminal pipeline_run % (run status=%); reason=orphan_under_terminal_run',
    TG_TABLE_NAME, NEW.id, prev_status, NEW.pipeline_run_id, run_status;

  RETURN NEW;
END;
$$;
