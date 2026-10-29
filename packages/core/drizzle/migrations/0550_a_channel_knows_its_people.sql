-- A bound Rocket.Chat group's channel record (REQ-75 r6 BC-30..BC-41), in Forge and shared by every
-- room row (bot session) of the project bound to that group:
--   support_channels               one per (project, group)
--   support_channel_members        a member by Rocket.Chat username: roles, what to ask them for,
--                                  inferred by the bot or confirmed by a person
--   support_channel_rules          an instruction a team member gave, linked to its message, or a rule
--                                  a person added in Forge
--   support_channel_common_issues  a question asked in several threads, with its one answer and the
--                                  Feedback a defect was recorded as
-- and five support action kinds: channel_written, routed, announced, secret_flagged, result_told.
-- `progress_posted` stays a legal kind for the rows written before r6; nothing writes it now.
-- Every table is new and the kind check only widens, so no existing row can fail a check.
--
-- ROLLBACK: DROP TABLE support_channel_common_issues, support_channel_rules, support_channel_members,
--   support_channels; once no row holds a new kind, restore support_actions_kind_chk as 0539 wrote it.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"rid" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_channels" DROP CONSTRAINT IF EXISTS "support_channels_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "support_channels" ADD CONSTRAINT "support_channels_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_channels_project_rid_uq" ON "support_channels" USING btree ("project_id","rid");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_channel_members" (
	"channel_id" uuid NOT NULL,
	"username" text NOT NULL,
	"roles" text[] NOT NULL,
	"ask_for" text,
	"state" text NOT NULL,
	"confirmed_by" uuid,
	"source_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_channel_members_pk" PRIMARY KEY ("channel_id","username"),
	CONSTRAINT "support_channel_members_roles_chk" CHECK (cardinality("support_channel_members"."roles") >= 1 AND "support_channel_members"."roles" <@ ARRAY['user', 'product', 'technical', 'maintenance', 'bot']::text[]),
	CONSTRAINT "support_channel_members_state_chk" CHECK ("support_channel_members"."state" IN ('inferred', 'confirmed'))
);
--> statement-breakpoint
ALTER TABLE "support_channel_members" DROP CONSTRAINT IF EXISTS "support_channel_members_channel_id_support_channels_id_fk";--> statement-breakpoint
ALTER TABLE "support_channel_members" ADD CONSTRAINT "support_channel_members_channel_id_support_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."support_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_channel_members" DROP CONSTRAINT IF EXISTS "support_channel_members_confirmed_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "support_channel_members" ADD CONSTRAINT "support_channel_members_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_channel_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"text" text NOT NULL,
	"author" text,
	"message_id" text,
	"thread" text,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "support_channel_rules_source_chk" CHECK (("support_channel_rules"."message_id" IS NULL) = ("support_channel_rules"."author" IS NULL) AND ("support_channel_rules"."message_id" IS NULL) = ("support_channel_rules"."thread" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "support_channel_rules" DROP CONSTRAINT IF EXISTS "support_channel_rules_channel_id_support_channels_id_fk";--> statement-breakpoint
ALTER TABLE "support_channel_rules" ADD CONSTRAINT "support_channel_rules_channel_id_support_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."support_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_channel_rules" DROP CONSTRAINT IF EXISTS "support_channel_rules_added_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "support_channel_rules" ADD CONSTRAINT "support_channel_rules_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_channel_rules_message_uq" ON "support_channel_rules" USING btree ("channel_id","message_id") WHERE "support_channel_rules"."removed_at" IS NULL AND "support_channel_rules"."message_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_channel_common_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"question" text NOT NULL,
	"question_key" text NOT NULL,
	"answer" text NOT NULL,
	"threads" text[] NOT NULL,
	"feedback_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "support_channel_common_issues_threads_chk" CHECK (cardinality("support_channel_common_issues"."threads") >= 2)
);
--> statement-breakpoint
ALTER TABLE "support_channel_common_issues" DROP CONSTRAINT IF EXISTS "support_channel_common_issues_channel_id_support_channels_id_fk";--> statement-breakpoint
ALTER TABLE "support_channel_common_issues" ADD CONSTRAINT "support_channel_common_issues_channel_id_support_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."support_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_channel_common_issues" DROP CONSTRAINT IF EXISTS "support_channel_common_issues_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "support_channel_common_issues" ADD CONSTRAINT "support_channel_common_issues_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_channel_common_issues_question_uq" ON "support_channel_common_issues" USING btree ("channel_id","question_key") WHERE "support_channel_common_issues"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation', 'channel_written', 'routed', 'announced', 'secret_flagged', 'result_told'));
