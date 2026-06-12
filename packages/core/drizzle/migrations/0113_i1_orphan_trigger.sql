-- ISS-448 (ISS-442 C2, invariant I1) — bypass-proof DB backstop: no NON-terminal
-- child (`jobs` / `agent_sessions`) may live under a TERMINAL `pipeline_run`.
--
-- Decision A = Postgres TRIGGER, STAGED rollout:
--   PHASE 1 (this migration) = ALARM MODE. When an *active* child row is written
--     under a *terminal* run the trigger AUTO-CANCELS that row (terminal status +
--     failure_reason = 'orphan_under_terminal_run'), records a `kernel_transitions`
--     audit row (source = 'i1_trigger', so I2's audit trail + C6's metrics still
--     see every terminal flip even when the write bypassed applyKernelTransition),
--     and RAISE LOG — but does NOT hard-reject (no RAISE EXCEPTION yet).
--   PHASE 2 (flip DEFERRED to the ISS-442 PARENT integration step, after C3's
--     reconcile loop is proven) = HARD-REJECT: replace the auto-cancel body below
--     with `RAISE EXCEPTION` so the offending write is refused outright. Until
--     then alarm mode lets us observe (via the audit table + logs) without risking
--     a wedge from a path we have not yet migrated onto applyKernelTransition.
--
-- Terminal semantics MIRROR lifecycle/transition.ts:applyKernelTransition (C1) —
-- do not let them drift:
--   pipeline_run terminal = completed | failed | cancelled   (active = running | paused)
--   jobs           active  = queued | dispatched | running
--   agent_sessions active  = idle | queued | running
-- agent_sessions has no 'cancelled' status; 'cancelled_stale' (ISS-197) is its
-- non-failure terminal marker and the right fit for a stale orphan.
--
-- This is a BACKSTOP, not the primary path: it does NOT duplicate the cascade in
-- runs-cascade.ts — it only catches active writes that evade the TS chokepoint.
-- The trigger early-returns on terminal-status writes (the cascade / finalize
-- path), and a WHEN clause means the function body never runs for those at all,
-- so per-write overhead is one indexed PK lookup of the parent run, charged only
-- to active-status writes.
--
-- Hand-written (stored function); registered in meta/_journal.json.

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
  -- here instead — see migration header).
  prev_status := NEW.status;

  INSERT INTO "kernel_transitions"
    ("entity", "entity_id", "from_status", "to_status", "reason", "actor_type", "actor_id", "source")
  VALUES
    (CASE WHEN TG_TABLE_NAME = 'jobs' THEN 'job' ELSE 'session' END,
     NEW.id, prev_status, terminal_status, 'orphan_under_terminal_run',
     'system', NULL, 'i1_trigger');

  IF TG_TABLE_NAME = 'jobs' THEN
    NEW.status := 'cancelled';
    NEW.failure_kind := 'transient';
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
--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_jobs_no_active_under_terminal_run" ON "jobs";--> statement-breakpoint
CREATE TRIGGER "trg_jobs_no_active_under_terminal_run"
  BEFORE INSERT OR UPDATE ON "jobs"
  FOR EACH ROW
  WHEN (NEW.status IN ('queued', 'dispatched', 'running') AND NEW.pipeline_run_id IS NOT NULL)
  EXECUTE FUNCTION "enforce_no_active_child_under_terminal_run"();--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_agent_sessions_no_active_under_terminal_run" ON "agent_sessions";--> statement-breakpoint
CREATE TRIGGER "trg_agent_sessions_no_active_under_terminal_run"
  BEFORE INSERT OR UPDATE ON "agent_sessions"
  FOR EACH ROW
  WHEN (NEW.status IN ('idle', 'queued', 'running') AND NEW.pipeline_run_id IS NOT NULL)
  EXECUTE FUNCTION "enforce_no_active_child_under_terminal_run"();
