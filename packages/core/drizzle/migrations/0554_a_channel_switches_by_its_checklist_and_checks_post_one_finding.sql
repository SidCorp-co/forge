-- ISS-765 (REQ-77 BC-13, BC-16..BC-19). Two additions, neither rewriting a row, so nothing is lost:
--   1. support_channel_switches: a group's switch from the bot outside Forge that answers it to the
--      project's channel agent, with its duty checklist, the earlier switch it waits on, and the
--      owner's word where it is needed. The binding door reads it before a group in `outsideRids`
--      may join the agent.
--   2. support_actions takes the kinds `check_result` (a channel agent's one result for one firing of
--      a scheduled check) and `check_posted` (the finding core posted), and one check_result per
--      firing is held by a unique index.
--
-- ROLLBACK (only while no row holds a new kind, and nothing reads the table):
--   DROP TABLE support_channel_switches;
--   DROP INDEX support_actions_check_result_uq;
--   restore support_actions_kind_chk as 0550 wrote it.
CREATE TABLE IF NOT EXISTS "support_channel_switches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"rid" text NOT NULL,
	"outside_bot_user_id" text NOT NULL,
	"outside_bot_username" text,
	"duties" jsonb NOT NULL,
	"after_switch_id" uuid,
	"owner_word_needed" boolean DEFAULT false NOT NULL,
	"owner_word" text,
	"owner_word_by" uuid,
	"owner_word_at" timestamp with time zone,
	"applying_at" timestamp with time zone,
	"switched_at" timestamp with time zone,
	"switched_by" uuid,
	"proven_at" timestamp with time zone,
	"proven_by" uuid,
	"proven_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_channel_switches_not_self_chk" CHECK ("support_channel_switches"."after_switch_id" IS NULL OR "support_channel_switches"."after_switch_id" <> "support_channel_switches"."id"),
	CONSTRAINT "support_channel_switches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "support_channel_switches_after_fk" FOREIGN KEY ("after_switch_id") REFERENCES "public"."support_channel_switches"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "support_channel_switches_owner_word_by_users_id_fk" FOREIGN KEY ("owner_word_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "support_channel_switches_switched_by_users_id_fk" FOREIGN KEY ("switched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "support_channel_switches_proven_by_users_id_fk" FOREIGN KEY ("proven_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "support_channel_switches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_channel_switches_project_rid_uq" ON "support_channel_switches" USING btree ("project_id","rid");
--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";
--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation', 'channel_written', 'routed', 'announced', 'secret_flagged', 'result_told', 'check_result', 'check_posted'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_actions_check_result_uq" ON "support_actions" USING btree ("room_id","thread") WHERE kind = 'check_result';
