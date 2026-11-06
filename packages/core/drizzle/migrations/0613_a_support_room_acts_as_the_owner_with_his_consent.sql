-- ISS-1013 (REQ-85, FB-507, FB-540). A support room acts in its bound product as the owner, with his
-- consent and a credential core keeps. Two additions, neither rewriting a row:
--   1. support_owner_consents: each consent the owner gave in his own room, for one product (a
--      support-api binding), with the message he said it in; withdrawn by his word, it keeps the
--      withdrawing message and its time. One standing consent per room and product.
--   2. support_actions takes the kinds `owner_consented`, `owner_withdrew` and `owner_act`.
--
-- ROLLBACK (only while no row holds a new kind, and nothing reads the table):
--   DROP TABLE support_owner_consents;
--   restore support_actions_kind_chk as 0605 wrote it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_owner_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"owner_key" text NOT NULL,
	"owner_label" text,
	"thread" text NOT NULL,
	"given_message" text NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_message" text,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "support_owner_consents_withdrawn_chk" CHECK (("support_owner_consents"."withdrawn_at" IS NULL) = ("support_owner_consents"."withdrawn_message" IS NULL))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_owner_consents" ADD CONSTRAINT "support_owner_consents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_owner_consents" ADD CONSTRAINT "support_owner_consents_room_id_support_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_owner_consents" ADD CONSTRAINT "support_owner_consents_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_owner_consents_standing_uq" ON "support_owner_consents" USING btree ("room_id","binding_id") WHERE withdrawn_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_owner_consents_project_idx" ON "support_owner_consents" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation', 'channel_written', 'routed', 'announced', 'secret_flagged', 'result_told', 'check_result', 'check_posted', 'promise_made', 'promise_told', 'owner_consented', 'owner_withdrew', 'owner_act'));
