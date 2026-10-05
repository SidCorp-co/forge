-- ISS-218: the schema the simplify lanes left with no reader and no writer is dropped.
--
-- ROLLBACK: none for the columns. The log_tail columns are deleted with their contents and cannot be
-- recreated from the code or from this file; undoing it means restoring from a backup taken before
-- it ran. The two CHECKs can be widened again by hand.
--
-- A value narrowed out of a CHECK or a vocabulary is checked against the rows first: a row holding it
-- aborts this migration naming that row, and is never deleted or relabelled here.

-- The PM agent is gone (ISS-220): 'pm' leaves the run and session kind CHECKs, as it already left
-- `pipelineRunKinds` and `agentSessionKinds`.
DO $$
DECLARE r record;
BEGIN
  SELECT id INTO r FROM "pipeline_runs" WHERE "kind" = 'pm' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pipeline_runs % has kind pm, which pipeline_runs_kind_chk no longer allows; relabel or remove it before this migration', r.id;
  END IF;
  SELECT id INTO r FROM "agent_sessions" WHERE "kind" = 'pm' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent_sessions % has kind pm, which agent_sessions_kind_check no longer allows; relabel or remove it before this migration', r.id;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "pipeline_runs" DROP CONSTRAINT IF EXISTS "pipeline_runs_kind_chk";--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_kind_chk" CHECK ("kind" IN ('issue', 'interactive', 'system'));--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_kind_check";--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_kind_check" CHECK ("kind" IN ('master', 'run_session', 'pipeline', 'chat'));--> statement-breakpoint

-- The retired org admin route was the only writer of changed_by 'admin' (ISS-213); `preferenceChangeActors`
-- drops it. The column carries no CHECK, so a stored 'admin' row would read as a value the type cannot hold.
DO $$
DECLARE r record;
BEGIN
  SELECT id, changed_by INTO r FROM "preference_changes" WHERE "changed_by" NOT IN ('person', 'assistant') LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'preference_changes % has changed_by %, which preferenceChangeActors no longer holds; relabel or remove it before this migration', r.id, r.changed_by;
  END IF;
END $$;--> statement-breakpoint

-- The release attempt's log tail lost its only writer with the attempts/account route (ISS-213);
-- log_tail_read_at/by never had one.
ALTER TABLE "release_attempts" DROP COLUMN IF EXISTS "log_tail";--> statement-breakpoint
ALTER TABLE "release_attempts" DROP COLUMN IF EXISTS "log_tail_truncated";--> statement-breakpoint
ALTER TABLE "release_attempts" DROP COLUMN IF EXISTS "log_tail_read_at";--> statement-breakpoint
ALTER TABLE "release_attempts" DROP COLUMN IF EXISTS "log_tail_read_by";
