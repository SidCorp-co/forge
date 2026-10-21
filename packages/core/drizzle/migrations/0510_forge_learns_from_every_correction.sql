-- Forge learns from every correction and stops to ask when a lesson confuses (REQ-50; design in
-- docs/proposals/lessons.md):
--   lessons              one sentence learned from corrections (L-n), scoped to the project, an area
--                        or a kind of item; its status moves only through the kernel (machine `lesson`)
--   corrections          each return, rejection or failing verdict said with a reason, and each chat
--                        reply the classifier kept; unique per source event
--   lesson_applications  each output a lesson shaped, and whether a person marked it wrongly applied
--   lesson_confusions    an agent's stop-and-ask about a lesson, with both sides, the recommended
--                        resolution and the person's decision
-- and the two outbox event types the lessons module reads: mockup.transitioned and chat.replied.
-- knowledge_entries.kind carries no CHECK (its enum is the column's TypeScript type alone), so the
-- new kind `lesson` needs no statement here. Every table is new, so no existing row can fail a check.
-- A confusion the Assistant raises from a chat is held for the person's press like every chat write
-- (REQ-30 BC-4), so chat_proposals.kind widens to `lesson_confusion`; every stored row holds one of
-- the eleven kinds it keeps, so none can fail it.
--
-- ROLLBACK: DROP TABLE lesson_confusions, lesson_applications, corrections, lessons; DELETE FROM
-- outbox_event_types WHERE type IN ('mockup.transitioned', 'chat.replied'), once no pipeline_outbox
-- row names them; DELETE FROM knowledge_entries WHERE kind = 'lesson'; DELETE FROM chat_proposals
-- WHERE kind = 'lesson_confusion', then restore the eleven-kind chat_proposals_kind_chk.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"sentence" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_area_id" uuid,
	"scope_item_kind" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"proposed_agency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"decided_reason" text,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp with time zone,
	"retire_reason" text,
	"retire_proposed_at" timestamp with time zone,
	"kept_at" timestamp with time zone,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"check_issue_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lessons_number_chk" CHECK ("lessons"."number" >= 1),
	CONSTRAINT "lessons_sentence_chk" CHECK (length("lessons"."sentence") BETWEEN 1 AND 240),
	CONSTRAINT "lessons_scope_kind_chk" CHECK ("lessons"."scope_kind" IN ('project', 'area', 'item_kind')),
	CONSTRAINT "lessons_scope_item_kind_chk" CHECK ("lessons"."scope_item_kind" IS NULL OR "lessons"."scope_item_kind" IN ('requirement', 'workflow', 'mockup', 'suggestion', 'issue', 'chat')),
	CONSTRAINT "lessons_scope_chk" CHECK (("lessons"."scope_kind" = 'area') = ("lessons"."scope_area_id" IS NOT NULL) AND ("lessons"."scope_kind" = 'item_kind') = ("lessons"."scope_item_kind" IS NOT NULL)),
	CONSTRAINT "lessons_status_chk" CHECK ("lessons"."status" IN ('proposed', 'approved', 'held', 'rejected', 'retired')),
	CONSTRAINT "lessons_agency_chk" CHECK ("lessons"."proposed_agency" IN ('human', 'agent')),
	CONSTRAINT "lessons_approved_chk" CHECK ("lessons"."status" IN ('proposed', 'rejected') OR "lessons"."approved_at" IS NOT NULL),
	CONSTRAINT "lessons_decided_reason_chk" CHECK ("lessons"."status" NOT IN ('rejected', 'retired') OR "lessons"."decided_reason" IS NOT NULL),
	CONSTRAINT "lessons_retire_chk" CHECK (("lessons"."retire_reason" IS NULL) = ("lessons"."retire_proposed_at" IS NULL) AND ("lessons"."retire_reason" IS NULL OR "lessons"."retire_reason" IN ('superseded', 'unused'))),
	CONSTRAINT "lessons_applied_chk" CHECK ("lessons"."applied_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_scope_area_id_requirement_areas_id_fk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_scope_area_id_requirement_areas_id_fk" FOREIGN KEY ("scope_area_id") REFERENCES "public"."requirement_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_proposed_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_approved_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_supersedes_id_lessons_id_fk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_supersedes_id_lessons_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_superseded_by_id_lessons_id_fk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_superseded_by_id_lessons_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" DROP CONSTRAINT IF EXISTS "lessons_check_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_check_issue_id_issues_id_fk" FOREIGN KEY ("check_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lessons_project_number_uq" ON "lessons" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lessons_project_status_idx" ON "lessons" USING btree ("project_id","status");--> statement-breakpoint
SELECT forge_guard_status_column('lessons'::regclass, 'status', 'lesson');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"item_kind" text NOT NULL,
	"item_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"item_title" text,
	"area_id" uuid,
	"reason" text NOT NULL,
	"by_user_id" uuid,
	"agency" text NOT NULL,
	"said_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lesson_id" uuid,
	"linked_at" timestamp with time zone,
	"score" real,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid,
	CONSTRAINT "corrections_source_chk" CHECK ("corrections"."source" IN ('mockup_returned', 'mockup_accepted', 'suggestion_rejected', 'design_returned', 'revision_returned', 'verdict_failed', 'chat')),
	CONSTRAINT "corrections_item_kind_chk" CHECK ("corrections"."item_kind" IN ('mockup', 'suggestion', 'workflow', 'requirement', 'issue', 'conversation')),
	CONSTRAINT "corrections_reason_chk" CHECK (length(btrim("corrections"."reason")) >= 1),
	CONSTRAINT "corrections_agency_chk" CHECK ("corrections"."agency" IN ('human', 'agent')),
	CONSTRAINT "corrections_score_chk" CHECK (("corrections"."source" = 'chat') = ("corrections"."score" IS NOT NULL) AND ("corrections"."score" IS NULL OR "corrections"."score" BETWEEN 0 AND 1)),
	CONSTRAINT "corrections_link_chk" CHECK (("corrections"."lesson_id" IS NULL) = ("corrections"."linked_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_area_id_requirement_areas_id_fk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_area_id_requirement_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."requirement_areas"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_by_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_lesson_id_lessons_id_fk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_dismissed_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "corrections_source_ref_uq" ON "corrections" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_project_said_idx" ON "corrections" USING btree ("project_id","said_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_lesson_idx" ON "corrections" USING btree ("lesson_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corrections_unlinked_idx" ON "corrections" USING btree ("project_id") WHERE lesson_id IS NULL AND dismissed_at IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lesson_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"output_kind" text NOT NULL,
	"output_ref" text NOT NULL,
	"agent_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"wrong_at" timestamp with time zone,
	"wrong_by" uuid,
	"wrong_reason" text,
	CONSTRAINT "lesson_applications_kind_chk" CHECK ("lesson_applications"."output_kind" IN ('chat_message', 'steward_run', 'job', 'issue')),
	CONSTRAINT "lesson_applications_wrong_chk" CHECK (("lesson_applications"."wrong_at" IS NULL) = ("lesson_applications"."wrong_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "lesson_applications" DROP CONSTRAINT IF EXISTS "lesson_applications_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD CONSTRAINT "lesson_applications_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_applications" DROP CONSTRAINT IF EXISTS "lesson_applications_lesson_id_lessons_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD CONSTRAINT "lesson_applications_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_applications" DROP CONSTRAINT IF EXISTS "lesson_applications_agent_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD CONSTRAINT "lesson_applications_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_applications" DROP CONSTRAINT IF EXISTS "lesson_applications_wrong_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_applications" ADD CONSTRAINT "lesson_applications_wrong_by_users_id_fk" FOREIGN KEY ("wrong_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lesson_applications_output_uq" ON "lesson_applications" USING btree ("lesson_id","output_kind","output_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lesson_applications_lesson_idx" ON "lesson_applications" USING btree ("lesson_id","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lesson_applications_ref_idx" ON "lesson_applications" USING btree ("project_id","output_kind","output_ref");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lesson_confusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"other_lesson_id" uuid,
	"other_ref" text,
	"side_lesson" text NOT NULL,
	"side_other" text NOT NULL,
	"recommended" text NOT NULL,
	"recommended_sentence" text,
	"application_id" uuid,
	"raised_by" uuid,
	"raised_agency" text NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"resolution" text,
	CONSTRAINT "lesson_confusions_kind_chk" CHECK ("lesson_confusions"."kind" IN ('conflict', 'contradicts', 'unclear', 'wrongly_applied')),
	CONSTRAINT "lesson_confusions_recommended_chk" CHECK ("lesson_confusions"."recommended" IN ('keep', 'edit', 'retire') AND ("lesson_confusions"."recommended" <> 'edit' OR "lesson_confusions"."recommended_sentence" IS NOT NULL)),
	CONSTRAINT "lesson_confusions_decided_chk" CHECK (("lesson_confusions"."decided_at" IS NULL) = ("lesson_confusions"."resolution" IS NULL) AND ("lesson_confusions"."resolution" IS NULL OR "lesson_confusions"."resolution" IN ('keep', 'edit', 'retire'))),
	CONSTRAINT "lesson_confusions_agency_chk" CHECK ("lesson_confusions"."raised_agency" IN ('human', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "lesson_confusions" DROP CONSTRAINT IF EXISTS "lesson_confusions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD CONSTRAINT "lesson_confusions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_confusions" DROP CONSTRAINT IF EXISTS "lesson_confusions_lesson_id_lessons_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD CONSTRAINT "lesson_confusions_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_confusions" DROP CONSTRAINT IF EXISTS "lesson_confusions_other_lesson_id_lessons_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD CONSTRAINT "lesson_confusions_other_lesson_id_lessons_id_fk" FOREIGN KEY ("other_lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_confusions" DROP CONSTRAINT IF EXISTS "lesson_confusions_application_id_lesson_applications_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD CONSTRAINT "lesson_confusions_application_id_lesson_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."lesson_applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_confusions" DROP CONSTRAINT IF EXISTS "lesson_confusions_raised_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD CONSTRAINT "lesson_confusions_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_confusions" DROP CONSTRAINT IF EXISTS "lesson_confusions_decided_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "lesson_confusions" ADD CONSTRAINT "lesson_confusions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lesson_confusions_open_idx" ON "lesson_confusions" USING btree ("project_id","raised_at") WHERE decided_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lesson_confusions_lesson_idx" ON "lesson_confusions" USING btree ("lesson_id");--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('mockup.transitioned'), ('chat.replied') ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_kind_chk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_kind_chk" CHECK ("chat_proposals"."kind" IN ('feedback', 'requirement_draft', 'requirement_revision', 'comment', 'attachment', 'memory_note', 'preferences', 'report_save', 'issue_change', 'requirement_link', 'project_change', 'lesson_confusion'));
