-- A project's Rocket.Chat support group is answered by one Claude session Forge manages (REQ-75 r2):
--   support_rooms           the group a rocketchat binding names, the agent account its session acts
--                           as (a member of nothing) and the session that answers it
--   support_actions         every action in the group: inbound messages (undelivered until a turn takes
--                           them), replies, checks, fixes, filings, progress posts, refusals
--   support_fixes           a fix the session proposed, waiting on the one account that asked
--   support_feedback_links  a Feedback item the session recorded and the thread its progress is posted in
-- and the external reporter channel `rocketchat` beside `widget`. A widget visitor is handed a status
-- link; a group member is not (anyone in the group could open it, and the thread is its status), so
-- status_token_hash is held by exactly the widget rows. Every table is new and every existing reporter
-- row is a widget row holding its hash, so no existing row can fail a check; the channel check only
-- widens.
--
-- ROLLBACK: DROP TABLE support_feedback_links, support_fixes, support_actions, support_rooms; once no
-- row names 'rocketchat', drop feedback_external_reporters_status_link_chk, SET NOT NULL on
-- status_token_hash and restore feedback_external_reporters_channel_chk to IN ('widget').
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"rid" text NOT NULL,
	"principal_user_id" uuid NOT NULL,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_binding_id_integration_bindings_id_fk";--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_principal_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_session_id_agent_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_rooms_binding_uq" ON "support_rooms" USING btree ("binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_rooms_connection_rid_uq" ON "support_rooms" USING btree ("connection_id","rid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_rooms_principal_uq" ON "support_rooms" USING btree ("principal_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_rooms_project_idx" ON "support_rooms" USING btree ("project_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid,
	"thread" text NOT NULL,
	"kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_key" text,
	"actor_label" text,
	"tool" text,
	"input" jsonb,
	"output" jsonb,
	"external_id" text,
	"fix_id" uuid,
	"feedback_id" uuid,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused')),
	CONSTRAINT "support_actions_actor_chk" CHECK ("support_actions"."actor_kind" IN ('member', 'session', 'core') AND ("support_actions"."actor_kind" = 'member') = ("support_actions"."actor_key" IS NOT NULL)),
	CONSTRAINT "support_actions_delivered_chk" CHECK ("support_actions"."delivered_at" IS NULL OR "support_actions"."kind" = 'message_in')
);
--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_room_id_support_rooms_id_fk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_room_id_support_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_actions_room_created_idx" ON "support_actions" USING btree ("room_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_actions_undelivered_idx" ON "support_actions" USING btree ("room_id","created_at") WHERE kind = 'message_in' AND delivered_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_actions_inbound_uq" ON "support_actions" USING btree ("room_id","external_id") WHERE kind = 'message_in';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_fixes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"thread" text NOT NULL,
	"tool" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"asker_key" text NOT NULL,
	"asker_label" text,
	"code" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "support_fixes_state_chk" CHECK ("support_fixes"."state" IN ('pending', 'ran', 'failed', 'declined', 'expired')),
	CONSTRAINT "support_fixes_code_chk" CHECK ("support_fixes"."code" ~ '^[A-HJ-NP-Z2-9]{6}$'),
	CONSTRAINT "support_fixes_decided_chk" CHECK (("support_fixes"."state" = 'pending') = ("support_fixes"."decided_at" IS NULL)),
	CONSTRAINT "support_fixes_expiry_chk" CHECK ("support_fixes"."expires_at" > "support_fixes"."created_at")
);
--> statement-breakpoint
ALTER TABLE "support_fixes" DROP CONSTRAINT IF EXISTS "support_fixes_room_id_support_rooms_id_fk";--> statement-breakpoint
ALTER TABLE "support_fixes" ADD CONSTRAINT "support_fixes_room_id_support_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_fixes" DROP CONSTRAINT IF EXISTS "support_fixes_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "support_fixes" ADD CONSTRAINT "support_fixes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_fixes_pending_code_uq" ON "support_fixes" USING btree ("room_id","code") WHERE state = 'pending';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_feedback_links" (
	"feedback_id" uuid PRIMARY KEY NOT NULL,
	"room_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"thread" text NOT NULL,
	"last_phase" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "support_feedback_links_phase_chk" CHECK ("support_feedback_links"."last_phase" IN ('new', 'triaged', 'planned', 'resolved', 'reopened', 'verified', 'declined'))
);
--> statement-breakpoint
ALTER TABLE "support_feedback_links" DROP CONSTRAINT IF EXISTS "support_feedback_links_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "support_feedback_links" ADD CONSTRAINT "support_feedback_links_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_feedback_links" DROP CONSTRAINT IF EXISTS "support_feedback_links_room_id_support_rooms_id_fk";--> statement-breakpoint
ALTER TABLE "support_feedback_links" ADD CONSTRAINT "support_feedback_links_room_id_support_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_feedback_links" DROP CONSTRAINT IF EXISTS "support_feedback_links_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "support_feedback_links" ADD CONSTRAINT "support_feedback_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_feedback_links_open_idx" ON "support_feedback_links" USING btree ("project_id") WHERE closed_at IS NULL;--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" DROP CONSTRAINT IF EXISTS "feedback_external_reporters_channel_chk";--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" ADD CONSTRAINT "feedback_external_reporters_channel_chk" CHECK ("feedback_external_reporters"."channel" IN ('widget', 'rocketchat'));--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" ALTER COLUMN "status_token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" DROP CONSTRAINT IF EXISTS "feedback_external_reporters_status_link_chk";--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" ADD CONSTRAINT "feedback_external_reporters_status_link_chk" CHECK (("feedback_external_reporters"."channel" = 'widget') = ("feedback_external_reporters"."status_token_hash" IS NOT NULL));
