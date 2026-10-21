-- The steward acts at every Product and Delivery handoff (REQ-48 BC-1, BC-12; lane B of
-- docs/proposals/steward-agent.md):
--   steward_runs      one run per item and trigger, debounced: a live run (queued or running) is the
--                     only one its subject holds, by a partial unique index; what arrives while it is
--                     queued folds into acts_to_run, what arrives while it runs waits in follow_up and
--                     is the next run. basis is the standing it read; turns the gateway turns it spent.
--   steward_acts      each act a run took through an existing door, what it wrote and the door that
--                     undoes it; master_ask an ask of the master that stands until the sweep settles it.
--   steward_accounts  the one agent account per project the steward acts as.
-- and the four outbox event types the steward is started by: suggestion.proposed, standing.stuck,
-- standing.changed and release.held. jobs.type carries no CHECK (its enum is the column's TypeScript
-- type alone), so the new job type `steward` needs no statement here. Every table is new, so no
-- existing row can fail its checks.
--
-- ROLLBACK: DROP TABLE steward_acts, steward_runs, steward_accounts; DELETE FROM outbox_event_types
-- WHERE type IN ('suggestion.proposed', 'standing.stuck', 'standing.changed', 'release.held'), once no
-- pipeline_outbox row names them.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "steward_accounts" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "steward_accounts" DROP CONSTRAINT IF EXISTS "steward_accounts_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "steward_accounts" ADD CONSTRAINT "steward_accounts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_accounts" DROP CONSTRAINT IF EXISTS "steward_accounts_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "steward_accounts" ADD CONSTRAINT "steward_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_accounts_user_uq" ON "steward_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "steward_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"subject_key" text NOT NULL,
	"trigger" text NOT NULL,
	"events" jsonb NOT NULL,
	"acts_to_run" text[] NOT NULL,
	"follow_up" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"follow_up_events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"basis" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"skip_reason" text,
	"failure" text,
	"job_id" uuid,
	"turn_id" uuid,
	"turns" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "steward_runs_subject_kind_chk" CHECK ("steward_runs"."subject_kind" IN ('requirement', 'feedback', 'issue')),
	CONSTRAINT "steward_runs_trigger_chk" CHECK ("steward_runs"."trigger" IN ('requirement.agreed', 'breakdown.proposed', 'feedback.filed', 'standing.stuck', 'release.asked', 'release.held', 'release.shipped', 'standing.changed')),
	CONSTRAINT "steward_runs_state_chk" CHECK ("steward_runs"."state" IN ('queued', 'running', 'done', 'failed', 'skipped')),
	CONSTRAINT "steward_runs_skip_reason_chk" CHECK ("steward_runs"."skip_reason" IS NULL OR "steward_runs"."skip_reason" IN ('basis_unchanged', 'budget_spent', 'steward_off', 'subject_ended')),
	CONSTRAINT "steward_runs_acts_chk" CHECK (cardinality("steward_runs"."acts_to_run") >= 1 AND "steward_runs"."acts_to_run" <@ ARRAY['note', 'intake_check', 'breakdown_check', 'triage_draft', 'stuck_diagnosis', 'output_check', 'release_followthrough']::text[] AND "steward_runs"."follow_up" <@ ARRAY['note', 'intake_check', 'breakdown_check', 'triage_draft', 'stuck_diagnosis', 'output_check', 'release_followthrough']::text[]),
	CONSTRAINT "steward_runs_skip_chk" CHECK (("steward_runs"."state" = 'skipped') = ("steward_runs"."skip_reason" IS NOT NULL)),
	CONSTRAINT "steward_runs_failure_chk" CHECK (("steward_runs"."state" = 'failed') = ("steward_runs"."failure" IS NOT NULL)),
	CONSTRAINT "steward_runs_turns_chk" CHECK ("steward_runs"."turns" >= 0),
	CONSTRAINT "steward_runs_events_chk" CHECK (jsonb_typeof("steward_runs"."events") = 'array' AND jsonb_typeof("steward_runs"."follow_up_events") = 'array')
);
--> statement-breakpoint
ALTER TABLE "steward_runs" DROP CONSTRAINT IF EXISTS "steward_runs_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "steward_runs" ADD CONSTRAINT "steward_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_runs" DROP CONSTRAINT IF EXISTS "steward_runs_job_id_jobs_id_fk";--> statement-breakpoint
ALTER TABLE "steward_runs" ADD CONSTRAINT "steward_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "steward_runs_live_uq" ON "steward_runs" USING btree ("subject_kind","subject_id") WHERE state IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_runs_project_queued_idx" ON "steward_runs" USING btree ("project_id","queued_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_runs_due_idx" ON "steward_runs" USING btree ("not_before") WHERE state = 'queued';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_runs_subject_idx" ON "steward_runs" USING btree ("subject_kind","subject_id","queued_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_runs_job_idx" ON "steward_runs" USING btree ("job_id") WHERE job_id IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "steward_acts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"act" text NOT NULL,
	"door" text NOT NULL,
	"did" text NOT NULL,
	"wrote" jsonb,
	"undo" jsonb,
	"master_ask" text,
	"ask_settled_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"undone_by" uuid,
	"undo_wrote" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "steward_acts_act_chk" CHECK ("steward_acts"."act" IN ('note', 'intake_check', 'breakdown_check', 'triage_draft', 'stuck_diagnosis', 'output_check', 'release_followthrough')),
	CONSTRAINT "steward_acts_undo_chk" CHECK ("steward_acts"."undone_at" IS NULL OR "steward_acts"."undo" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "steward_acts" DROP CONSTRAINT IF EXISTS "steward_acts_run_id_steward_runs_id_fk";--> statement-breakpoint
ALTER TABLE "steward_acts" ADD CONSTRAINT "steward_acts_run_id_steward_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."steward_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_acts" DROP CONSTRAINT IF EXISTS "steward_acts_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "steward_acts" ADD CONSTRAINT "steward_acts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_acts" DROP CONSTRAINT IF EXISTS "steward_acts_undone_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "steward_acts" ADD CONSTRAINT "steward_acts_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_acts_run_idx" ON "steward_acts" USING btree ("run_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "steward_acts_open_ask_idx" ON "steward_acts" USING btree ("project_id") WHERE master_ask IS NOT NULL AND ask_settled_at IS NULL AND undone_at IS NULL;--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('suggestion.proposed'), ('standing.stuck'), ('standing.changed'), ('release.held') ON CONFLICT DO NOTHING;
