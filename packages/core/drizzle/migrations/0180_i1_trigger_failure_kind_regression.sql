-- Repair 0178. RFC 0002 phase 1 amended the I1 orphan trigger to know about
-- `held`, but it built its `CREATE OR REPLACE` from the 0113 body instead of the
-- live 0118 one — reviving `NEW.failure_kind := 'transient'`, a value the v3
-- CHECK from 0115 (`code|infra|transient-cc|timeout`) rejects.
--
-- That is not a cosmetic regression. The trigger runs in ALARM mode: it is
-- supposed to auto-cancel an active child written under a terminal run and let
-- the write through. With an invalid failure_kind the INSERT/UPDATE raises
-- 23514 instead, so every such write fails outright — the accidental
-- hard-reject 0118's own header predicted, arriving four migrations later by
-- copying the file it replaced.
--
-- Only the literal changes; the `held` additions from 0178 (the active list and
-- the trigger's WHEN clause) are preserved verbatim. Re-creating the whole
-- function rather than patching is the only option pg offers.
--
-- The trigger itself is NOT re-created: 0113/0178's trigger binds the function
-- by name, so CREATE OR REPLACE is picked up with no DDL on `jobs`.

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
  IF NEW.pipeline_run_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'jobs' THEN
    child_active := NEW.status IN ('queued', 'dispatched', 'running', 'held');
    terminal_status := 'cancelled';
  ELSIF TG_TABLE_NAME = 'agent_sessions' THEN
    child_active := NEW.status IN ('idle', 'queued', 'running');
    terminal_status := 'cancelled_stale';
  ELSE
    RETURN NEW;
  END IF;

  IF NOT child_active THEN
    RETURN NEW;
  END IF;

  SELECT status INTO run_status FROM pipeline_runs WHERE id = NEW.pipeline_run_id;

  IF run_status IS NULL OR run_status IN ('running', 'paused') THEN
    RETURN NEW;
  END IF;

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
