-- A chat's go-ahead was only an instruction to the model (ISS-439, REQ-30 BC-4): forge_feedback, the
-- requirement tools, a memory note, a comment or an attachment wrote the moment the model called
-- them. chat_proposals holds such a write instead of making it: exactly the call that was held (an
-- Assistant tool call, or an Agent session's REST request and its bytes), the person whose agreement
-- it waits on, and, once they decide, how they agreed and what the write made or why it was refused.
-- The table is new and starts empty; nothing earlier is backfilled, since no earlier write waited.
--
-- ROLLBACK: DROP TABLE IF EXISTS chat_proposals.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"proposed_to" uuid NOT NULL,
	"handle_user_id" uuid,
	"session_id" uuid,
	"kind" text NOT NULL,
	"form" text NOT NULL,
	"call" jsonb NOT NULL,
	"body" bytea,
	"summary" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"agreed_via" text,
	"agreed_words" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"record" jsonb,
	"failure" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_proposals_kind_chk" CHECK ("chat_proposals"."kind" IN ('feedback', 'requirement_draft', 'requirement_revision', 'comment', 'attachment', 'memory_note', 'preferences', 'report_save', 'issue_change')),
	CONSTRAINT "chat_proposals_form_chk" CHECK ("chat_proposals"."form" IN ('tool', 'rest')),
	CONSTRAINT "chat_proposals_status_chk" CHECK ("chat_proposals"."status" IN ('pending', 'agreed', 'recorded', 'failed', 'declined')),
	CONSTRAINT "chat_proposals_agreed_via_chk" CHECK ("chat_proposals"."agreed_via" IS NULL OR "chat_proposals"."agreed_via" IN ('card', 'reply')),
	CONSTRAINT "chat_proposals_body_chk" CHECK ("chat_proposals"."form" = 'rest' OR "chat_proposals"."body" IS NULL),
	CONSTRAINT "chat_proposals_decided_chk" CHECK (("chat_proposals"."status" = 'pending') = ("chat_proposals"."decided_at" IS NULL)),
	CONSTRAINT "chat_proposals_agreed_chk" CHECK (("chat_proposals"."status" IN ('agreed', 'recorded', 'failed')) = ("chat_proposals"."agreed_via" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_proposed_to_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_proposed_to_users_id_fk" FOREIGN KEY ("proposed_to") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_handle_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_handle_user_id_users_id_fk" FOREIGN KEY ("handle_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_session_id_agent_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_decided_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_proposals_conversation_idx" ON "chat_proposals" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_proposals_proposed_to_idx" ON "chat_proposals" USING btree ("proposed_to");
