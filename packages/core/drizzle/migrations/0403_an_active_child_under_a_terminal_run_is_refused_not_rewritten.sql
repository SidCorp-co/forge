-- ISS-219: a job or session written into an active status under a terminal pipeline run is refused
-- by name, where the I1 trigger (0113, last re-created in 0345) rewrote it to cancelled or
-- cancelled_stale and logged the substitution. A write that asks for an active child gets that, or
-- an error naming why not; the triggers and their coverage are unchanged.
--
-- ROLLBACK: re-create the 0345 function body. Rows this migration reads are not changed.
--
-- A child already active under a terminal run would make every later write to it fail, so one
-- found here aborts the migration naming the row; it is never cancelled to let this pass.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. Every table touched by this file
-- is locked up front, in one fixed order (alphabetical), before any statement holds a lock a live
-- session could be waiting behind; a table that stays busy past lock_timeout fails the deploy loudly
-- instead of deadlocking mid-file. A table this database never had is skipped.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_sessions', 'jobs', 'pipeline_runs'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(t));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE r record;
BEGIN
  SELECT 'jobs' AS t, j.id, j.status, j.pipeline_run_id AS run_id, p.status AS run_status INTO r
    FROM "jobs" j JOIN "pipeline_runs" p ON p.id = j.pipeline_run_id
   WHERE j.status IN ('queued', 'dispatched', 'running', 'held') AND p.status NOT IN ('running', 'paused')
   ORDER BY j.id LIMIT 1;
  IF NOT FOUND THEN
    SELECT 'agent_sessions' AS t, s.id, s.status, s.pipeline_run_id AS run_id, p.status AS run_status INTO r
      FROM "agent_sessions" s JOIN "pipeline_runs" p ON p.id = s.pipeline_run_id
     WHERE s.status IN ('idle', 'queued', 'running') AND p.status NOT IN ('running', 'paused')
     ORDER BY s.id LIMIT 1;
  END IF;
  IF FOUND THEN
    RAISE EXCEPTION '% % is % under pipeline_run % which is %; settle it before this migration, which stops rewriting such a row',
      r.t, r.id, r.status, r.run_id, r.run_status;
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_no_active_child_under_terminal_run"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
BEGIN
  IF NEW.pipeline_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'jobs' THEN
    IF NEW.status NOT IN ('queued', 'dispatched', 'running', 'held') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'agent_sessions' THEN
    IF NEW.status NOT IN ('idle', 'queued', 'running') THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  SELECT status INTO run_status FROM "pipeline_runs" WHERE id = NEW.pipeline_run_id;
  IF run_status IS NULL OR run_status IN ('running', 'paused') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ACTIVE_CHILD_UNDER_TERMINAL_RUN: % % cannot be % under pipeline_run % which is %',
    TG_TABLE_NAME, NEW.id, NEW.status, NEW.pipeline_run_id, run_status
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'no_active_child_under_terminal_run',
          TABLE = TG_TABLE_NAME;
END;
$$;
