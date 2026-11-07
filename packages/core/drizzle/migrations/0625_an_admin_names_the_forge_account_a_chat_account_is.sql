-- ISS-976 (FB-499, FB-563). A project admin names the Forge account a chat account is, for a speaker
-- the chat server cannot match by address, and the owner's cited answer is kept until then:
--   1. speaker_link_namings: new; empty. Each naming says who named it, when and why, resolves only
--      in its project, and is undone by keeping the row with who undid it and why.
--   2. support_actions takes the kind `answer_kept`.
--   3. speaker_link_codes is dropped: ISS-845 removed the door that minted and redeemed its codes, and
--      nothing reads or writes it since.
--
-- ROLLBACK (only while no row holds the kind `answer_kept`):
--   DROP TABLE speaker_link_namings;
--   restore support_actions_kind_chk as 0614 wrote it.
--   speaker_link_codes held sha256 digests of one-use codes that lapsed in 15 minutes and that nothing
--   can mint or redeem any more; recreate it empty from 0545 if ever wanted.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "speaker_link_namings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_namespace" text NOT NULL,
	"external_id" text NOT NULL,
	"external_label" text,
	"user_id" uuid NOT NULL,
	"named_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"named_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_by" uuid,
	"undone_at" timestamp with time zone,
	"undo_reason" text,
	CONSTRAINT "speaker_link_namings_undone_chk" CHECK (("speaker_link_namings"."undone_at" IS NULL) = ("speaker_link_namings"."undone_by" IS NULL) AND ("speaker_link_namings"."undone_at" IS NULL) = ("speaker_link_namings"."undo_reason" IS NULL))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "speaker_link_namings" ADD CONSTRAINT "speaker_link_namings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "speaker_link_namings" ADD CONSTRAINT "speaker_link_namings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "speaker_link_namings" ADD CONSTRAINT "speaker_link_namings_named_by_users_id_fk" FOREIGN KEY ("named_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "speaker_link_namings" ADD CONSTRAINT "speaker_link_namings_undone_by_users_id_fk" FOREIGN KEY ("undone_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "speaker_link_namings_standing_uq" ON "speaker_link_namings" USING btree ("project_id","source","external_namespace","external_id") WHERE undone_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "speaker_link_namings_user_idx" ON "speaker_link_namings" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation', 'channel_written', 'routed', 'announced', 'secret_flagged', 'result_told', 'check_result', 'check_posted', 'promise_made', 'promise_told', 'owner_consented', 'owner_withdrew', 'owner_act', 'owner_sign_in', 'owner_signed_in', 'answer_kept'));--> statement-breakpoint
DROP TABLE IF EXISTS "speaker_link_codes";
