-- project-onboarding `req-case`: the BA drafts first requirements on its own through a named
-- hand-off turn origin (conversation_windows.origin 'onboarding_handoff'), and the first-requirements
-- room asks through the onboarding questionnaire (questionnaire_batches.first_requirements_of).
-- agent-run-standing `waiting_gate`: a refused deploy-lock acquire leaves a record (who was refused,
-- against which lock, until when), and a release reads `deploy_locked` only from its own refusal.
--
-- ROLLBACK: DROP TABLE "deploy_lock_refusals"; delete batches with first_requirements_of set, DROP
-- that column and restore the two-owner arc check; delete onboarding_handoff windows and restore the
-- origin check without it.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "conversation_windows" DROP CONSTRAINT "conversation_windows_origin_known";--> statement-breakpoint
ALTER TABLE "conversation_windows" ADD CONSTRAINT "conversation_windows_origin_known" CHECK ("conversation_windows"."origin" IN ('inbound','heartbeat','onboarding_handoff'));--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD COLUMN "first_requirements_of" uuid REFERENCES "onboardings"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "questionnaire_batches" DROP CONSTRAINT "questionnaire_batches_arc_chk";--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_arc_chk" CHECK (num_nonnulls("questionnaire_batches"."onboarding_id", "questionnaire_batches"."requirement_id", "questionnaire_batches"."first_requirements_of") = 1);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questionnaire_batches_first_requirements_idx" ON "questionnaire_batches" ("first_requirements_of") WHERE "first_requirements_of" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deploy_lock_refusals" (
	"run_id" uuid NOT NULL REFERENCES "pipeline_runs"("id") ON DELETE cascade,
	"environment" text NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"holder_run_id" uuid,
	"holder_subject" text,
	"holder_acquired_at" timestamp with time zone,
	"refused_until" timestamp with time zone,
	"refused_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deploy_lock_refusals_run_id_environment_pk" PRIMARY KEY("run_id","environment")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deploy_lock_refusals_project_idx" ON "deploy_lock_refusals" USING btree ("project_id");
