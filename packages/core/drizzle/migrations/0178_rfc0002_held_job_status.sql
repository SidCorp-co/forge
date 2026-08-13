-- RFC 0002 (park axis separation) phase 1 — the DB-level twins of the new
-- `jobs.status = 'held'` value. `held` is NON-TERMINAL: a job blocked on a
-- mechanical condition (no runner, provider quota, project budget) waits there
-- instead of parking the issue at `waiting`.
--
-- Three places must learn about it, and each is a different invariant:
--
--   1. `jobs_active_unique` — the DB-level twin of L1 `issueBusyJob`
--      (jobs/dispatch-gates.ts). Without `held` here, `enqueue` can insert a
--      SECOND job of the same type for an issue whose first job is held, and the
--      dispatch gate's refusal becomes cosmetic.
--   2. `jobs_pm_per_project_unique_idx` — same rule for project-scoped PM jobs,
--      which carry a NULL issue_id and so are not covered by (1).
--   3. The I1 orphan trigger from `0113_i1_orphan_trigger.sql` — its "active"
--      list and, critically, the trigger's WHEN clause. The WHEN clause is what
--      decides whether the function body runs at all, so a `held` write under a
--      terminal run would bypass the backstop entirely if only the body were
--      amended. Terminal semantics are otherwise unchanged.
--
-- `held` is deliberately NOT added to `runner_load` / `running_ids`
-- (jobs/dispatch-gates.ts) nor to the runner in-flight count
-- (issues/pipeline-health.ts): being absent there is exactly what makes a held
-- job slotless, so it may wait indefinitely without consuming the runner cap or
-- the project's serial slot.
--
-- Plain DROP/CREATE, not CONCURRENTLY: drizzle runs migrations inside a
-- transaction. Both indexes are partial and cover only active rows, so the
-- rebuild scan is bounded.

DROP INDEX IF EXISTS "jobs_active_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_unique" ON "jobs" ("issue_id","type")
  WHERE status IN ('queued','dispatched','running','held') AND issue_id IS NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "jobs_pm_per_project_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_pm_per_project_unique_idx" ON "jobs" ("project_id")
  WHERE type = 'pm' AND status IN ('queued','dispatched','running','held');--> statement-breakpoint

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
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_jobs_no_active_under_terminal_run" ON "jobs";--> statement-breakpoint
CREATE TRIGGER "trg_jobs_no_active_under_terminal_run"
  BEFORE INSERT OR UPDATE ON "jobs"
  FOR EACH ROW
  WHEN (NEW.status IN ('queued', 'dispatched', 'running', 'held') AND NEW.pipeline_run_id IS NOT NULL)
  EXECUTE FUNCTION "enforce_no_active_child_under_terminal_run"();
