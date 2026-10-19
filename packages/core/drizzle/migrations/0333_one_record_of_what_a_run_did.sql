-- ISS-1133 — `phase_journal` (a clock) and `issue_step_contexts` (a handoff register) become one
-- record of what a run did, `run_journal`: one row per (run, phase, attempt), holding when the
-- attempt started and ended, its outcome, and its handoff. Nothing in a row is written twice; the
-- stores enforce it in their guarded UPDATEs and the two CHECKs keep each pair whole.
--
-- OLD ROWS ARE DROPPED, NOT CARRIED. Historical run detail is not worth a migration path, so no row
-- of either table is copied and nothing reconstructs one (the hourly jobs backfill is removed in
-- the same change). Because nothing is copied, no old row has to fit the new schema, and none can
-- stop this migration for not fitting; what the drop costs is counted instead. An open phase
-- dropped here is one a resuming session no longer finds, so it restarts that run at phase 1:
-- the NOTICE names how many there were.
--
-- `phase_step_durations` is a view over `phase_journal` with no reader in the code; it goes with it.
DO $$
DECLARE
  n_phases int;
  n_open int;
  n_handoffs int;
BEGIN
  -- Held to commit: a row written while this runs is either counted here or refused by the drop.
  LOCK TABLE phase_journal, issue_step_contexts IN ACCESS EXCLUSIVE MODE;

  SELECT count(*), count(*) FILTER (WHERE ended_at IS NULL) INTO n_phases, n_open FROM phase_journal;
  SELECT count(*) INTO n_handoffs FROM issue_step_contexts;

  -- The hourly backfill that rebuilt journal rows from `jobs` leaves in the same change. Its
  -- schedule is a row in pg-boss's own table, which would go on minting jobs no worker takes.
  IF to_regclass('pgboss.schedule') IS NOT NULL THEN
    DELETE FROM pgboss.schedule WHERE name = 'phase-journal-backfill';
  END IF;

  RAISE NOTICE 'ISS-1133: dropping % phase journal rows (% of them open, so a session resuming that run restarts at phase 1) and % step handoffs; none is carried into run_journal',
    n_phases, n_open, n_handoffs;
END $$;--> statement-breakpoint
DROP VIEW "phase_step_durations";--> statement-breakpoint
DROP TABLE "phase_journal";--> statement-breakpoint
DROP TABLE "issue_step_contexts";--> statement-breakpoint
CREATE TABLE "run_journal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"job_id" uuid,
	"agent_session_id" uuid,
	"phase" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"outcome" text,
	"artifact" jsonb,
	"handoff" jsonb,
	"handoff_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "run_journal_end_is_whole" CHECK ((ended_at IS NULL) = (outcome IS NULL)),
	CONSTRAINT "run_journal_handoff_is_whole" CHECK ((handoff IS NULL) = (handoff_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "run_journal" ADD CONSTRAINT "run_journal_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_journal" ADD CONSTRAINT "run_journal_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_journal" ADD CONSTRAINT "run_journal_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_journal" ADD CONSTRAINT "run_journal_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_journal" ADD CONSTRAINT "run_journal_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_journal_run_phase_attempt_idx" ON "run_journal" USING btree ("run_id","phase","attempt");--> statement-breakpoint
CREATE INDEX "run_journal_run_started_idx" ON "run_journal" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "run_journal_issue_started_idx" ON "run_journal" USING btree ("issue_id","started_at");--> statement-breakpoint
CREATE INDEX "run_journal_runner_verdicts_idx" ON "run_journal" USING btree ("run_id","started_at") WHERE source = 'runner' AND artifact ->> 'kind' = 'verdict';
