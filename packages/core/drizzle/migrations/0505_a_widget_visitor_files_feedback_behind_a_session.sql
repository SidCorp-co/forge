-- A widget visitor files Feedback behind a session (the feedback widget, 2026-10-16). A client site
-- embeds a chat whose end users are never Forge users; a widget binding's site key names it, and:
--   widget_principals            the agent-kind account each binding files Feedback as, a member of nothing
--   widget_sessions              a visitor session: the SHA-256 of its token, its conversation, who the
--                                visitor said they are, the page they were on and the origin that framed
--                                it, the turns they spent
--   widget_drafts                what the assistant proposed, pending until the visitor files or discards
--                                it; a filed one keeps its item's key and its status token, vault-sealed
--   feedback_external_reporters  who filed a Feedback item from outside Forge, and the SHA-256 of their
--                                private status link
-- and a unique index on a widget binding's site key, so one key never names two bindings. Every table
-- is new, so no existing row can fail its checks; the index covers only provider 'widget', which no
-- binding holds before this migration.
--
-- ROLLBACK: DROP TABLE widget_drafts, widget_sessions, widget_principals, feedback_external_reporters;
-- DROP INDEX integration_bindings_widget_site_key_uq.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_principals" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "widget_principals" DROP CONSTRAINT IF EXISTS "widget_principals_binding_id_integration_bindings_id_fk";--> statement-breakpoint
ALTER TABLE "widget_principals" ADD CONSTRAINT "widget_principals_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_principals" DROP CONSTRAINT IF EXISTS "widget_principals_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "widget_principals" ADD CONSTRAINT "widget_principals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_principals" DROP CONSTRAINT IF EXISTS "widget_principals_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "widget_principals" ADD CONSTRAINT "widget_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "widget_principals_user_uq" ON "widget_principals" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"binding_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"visitor_id" uuid NOT NULL,
	"identity_mode" text NOT NULL,
	"visitor_email" text,
	"visitor_name" text,
	"signed_user_id" text,
	"page_context" jsonb,
	"embedded_at" text,
	"turns" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "widget_sessions_token_hash_chk" CHECK ("widget_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "widget_sessions_identity_mode_chk" CHECK ("widget_sessions"."identity_mode" IN ('anonymous', 'email', 'signed')),
	CONSTRAINT "widget_sessions_identity_chk" CHECK (("widget_sessions"."identity_mode" <> 'email' OR "widget_sessions"."visitor_email" IS NOT NULL) AND ("widget_sessions"."identity_mode" = 'signed') = ("widget_sessions"."signed_user_id" IS NOT NULL)),
	CONSTRAINT "widget_sessions_page_context_chk" CHECK ("widget_sessions"."page_context" IS NULL OR jsonb_typeof("widget_sessions"."page_context") = 'object'),
	CONSTRAINT "widget_sessions_turns_chk" CHECK ("widget_sessions"."turns" >= 0),
	CONSTRAINT "widget_sessions_expiry_chk" CHECK ("widget_sessions"."expires_at" > "widget_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "widget_sessions" DROP CONSTRAINT IF EXISTS "widget_sessions_binding_id_integration_bindings_id_fk";--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_sessions" DROP CONSTRAINT IF EXISTS "widget_sessions_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_sessions" DROP CONSTRAINT IF EXISTS "widget_sessions_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "widget_sessions" ADD CONSTRAINT "widget_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "widget_sessions_token_hash_uq" ON "widget_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "widget_sessions_conversation_uq" ON "widget_sessions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_sessions_binding_visitor_idx" ON "widget_sessions" USING btree ("binding_id","visitor_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "widget_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"did" text,
	"saw" text NOT NULL,
	"expected" text,
	"where_seen" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"feedback_id" uuid,
	"feedback_key" text,
	"status_token_enc" bytea,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "widget_drafts_kind_chk" CHECK ("widget_drafts"."kind" IN ('bug', 'change_request', 'idea', 'question')),
	CONSTRAINT "widget_drafts_state_chk" CHECK ("widget_drafts"."state" IN ('pending', 'filed', 'discarded')),
	CONSTRAINT "widget_drafts_decided_chk" CHECK (("widget_drafts"."state" = 'pending') = ("widget_drafts"."decided_at" IS NULL)),
	CONSTRAINT "widget_drafts_feedback_chk" CHECK ("widget_drafts"."feedback_id" IS NULL OR "widget_drafts"."state" = 'filed'),
	CONSTRAINT "widget_drafts_filed_chk" CHECK (("widget_drafts"."state" = 'filed') = ("widget_drafts"."feedback_key" IS NOT NULL AND "widget_drafts"."status_token_enc" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "widget_drafts" DROP CONSTRAINT IF EXISTS "widget_drafts_session_id_widget_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "widget_drafts" ADD CONSTRAINT "widget_drafts_session_id_widget_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."widget_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_drafts" DROP CONSTRAINT IF EXISTS "widget_drafts_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "widget_drafts" ADD CONSTRAINT "widget_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_drafts" DROP CONSTRAINT IF EXISTS "widget_drafts_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "widget_drafts" ADD CONSTRAINT "widget_drafts_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_drafts_session_idx" ON "widget_drafts" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_external_reporters" (
	"feedback_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"binding_id" uuid,
	"visitor_id" uuid NOT NULL,
	"email" text,
	"name" text,
	"signed_user_id" text,
	"page_context" jsonb,
	"status_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_external_reporters_channel_chk" CHECK ("feedback_external_reporters"."channel" IN ('widget')),
	CONSTRAINT "feedback_external_reporters_status_token_chk" CHECK ("feedback_external_reporters"."status_token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "feedback_external_reporters_page_context_chk" CHECK ("feedback_external_reporters"."page_context" IS NULL OR jsonb_typeof("feedback_external_reporters"."page_context") = 'object')
);
--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" DROP CONSTRAINT IF EXISTS "feedback_external_reporters_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" ADD CONSTRAINT "feedback_external_reporters_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" DROP CONSTRAINT IF EXISTS "feedback_external_reporters_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" ADD CONSTRAINT "feedback_external_reporters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" DROP CONSTRAINT IF EXISTS "feedback_external_reporters_binding_id_integration_bindings_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_external_reporters" ADD CONSTRAINT "feedback_external_reporters_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_external_reporters_status_token_uq" ON "feedback_external_reporters" USING btree ("status_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_external_reporters_project_idx" ON "feedback_external_reporters" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_bindings_widget_site_key_uq" ON "integration_bindings" USING btree (("config" ->> 'siteKey')) WHERE "integration_bindings"."provider" = 'widget';
