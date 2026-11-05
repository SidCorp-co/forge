-- ISS-1012 (FB-512). A support room's session promises a person, in their thread, to tell them when
-- an issue of a project the room follows reaches an environment, named as the project's document
-- names it. Two additions, neither rewriting a row:
--   1. support_promises: each promise, who asked, which issue, which environment and when, and how
--      it was answered once (reached, dropped or untracked).
--   2. support_actions takes the kinds `promise_made` and `promise_told`.
--
-- ROLLBACK (only while no row holds a new kind, and nothing reads the table):
--   DROP TABLE support_promises;
--   restore support_actions_kind_chk as 0554 wrote it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"thread" text NOT NULL,
	"project_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"asker_key" text NOT NULL,
	"asker_label" text,
	"state" text DEFAULT 'open' NOT NULL,
	"served_commit" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "support_promises_state_chk" CHECK ("support_promises"."state" IN ('open', 'reached', 'dropped', 'untracked')),
	CONSTRAINT "support_promises_answered_chk" CHECK (("support_promises"."state" = 'open') = ("support_promises"."answered_at" IS NULL) AND ("support_promises"."served_commit" IS NULL OR "support_promises"."state" = 'reached'))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_promises" ADD CONSTRAINT "support_promises_room_id_support_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_promises" ADD CONSTRAINT "support_promises_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_promises" ADD CONSTRAINT "support_promises_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_promises_open_uq" ON "support_promises" USING btree ("room_id","thread","issue_id","environment") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_promises_open_project_idx" ON "support_promises" USING btree ("project_id") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_promises_issue_idx" ON "support_promises" USING btree ("issue_id");--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation', 'channel_written', 'routed', 'announced', 'secret_flagged', 'result_told', 'check_result', 'check_posted', 'promise_made', 'promise_told'));
