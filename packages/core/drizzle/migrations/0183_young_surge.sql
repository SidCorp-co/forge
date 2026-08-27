CREATE TABLE "phase_journal" (
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
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "phase_journal_verdict_is_runner_written" CHECK ("phase_journal"."artifact"->>'kind' IS DISTINCT FROM 'verdict' OR "phase_journal"."source" = 'runner')
);
--> statement-breakpoint
ALTER TABLE "phase_journal" ADD CONSTRAINT "phase_journal_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_journal" ADD CONSTRAINT "phase_journal_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_journal" ADD CONSTRAINT "phase_journal_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_journal" ADD CONSTRAINT "phase_journal_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_journal" ADD CONSTRAINT "phase_journal_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phase_journal_run_phase_attempt_idx" ON "phase_journal" USING btree ("run_id","phase","attempt");--> statement-breakpoint
CREATE INDEX "phase_journal_run_started_idx" ON "phase_journal" USING btree ("run_id","started_at");--> statement-breakpoint
CREATE INDEX "phase_journal_issue_started_idx" ON "phase_journal" USING btree ("issue_id","started_at");