-- One script sandbox for schedule scripts and the chat's computations (REQ-37, REQ-32 BC-16). The
-- sandbox runs JavaScript alone, and a script reads Forge only by GET through ctx.forge.get; each run
-- records who it read as and every read with its status (REQ-37 BC-9).
--
-- report_executions: the language check narrows to 'javascript', and `reads` holds the run's reads.
-- An execution kept in another language cannot be represented by the new check: the migration aborts
-- naming each one rather than deleting it. schedule_runs: `run_as` (who a script fire read as) and
-- `reads` are added, both null for any other fire.
--
-- ROLLBACK: drop schedule_runs.reads, schedule_runs.run_as and report_executions.reads with their
-- constraints, and restore report_executions_language_chk to IN ('python', 'bash') after deleting
-- every javascript execution (those computations then no longer exist to read back).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE
  unrepresentable text;
BEGIN
  SELECT string_agg(id::text || ' (' || language || ')', ', ') INTO unrepresentable
  FROM report_executions WHERE language <> 'javascript';
  IF unrepresentable IS NOT NULL THEN
    RAISE EXCEPTION 'report_executions holds executions in a language the script sandbox does not run, which report_executions_language_chk can no longer represent: %', unrepresentable;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "report_executions" DROP CONSTRAINT IF EXISTS "report_executions_language_chk";--> statement-breakpoint
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_language_chk" CHECK ("report_executions"."language" IN ('javascript'));--> statement-breakpoint
ALTER TABLE "report_executions" ADD COLUMN IF NOT EXISTS "reads" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "report_executions" DROP CONSTRAINT IF EXISTS "report_executions_reads_chk";--> statement-breakpoint
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_reads_chk" CHECK (jsonb_typeof("report_executions"."reads") = 'array');--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "run_as" uuid;--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_run_as_users_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_run_as_users_id_fk" FOREIGN KEY ("run_as") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "reads" jsonb;--> statement-breakpoint
ALTER TABLE "schedule_runs" DROP CONSTRAINT IF EXISTS "schedule_runs_reads_chk";--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_reads_chk" CHECK ("schedule_runs"."reads" IS NULL OR jsonb_typeof("schedule_runs"."reads") = 'array');
