-- ISS-1047 (REQ-85 BC-2, BC-3, BC-4). The owner signs in to a product through a sign-in core starts,
-- and core keeps and refreshes the OAuth credential that gives. Three additions, no row rewritten:
--   1. support_owner_sign_ins: each sign-in core started for the owner, with the hash of its OAuth
--      state and its PKCE verifier, sealed; spent once, with what came of it. No token is held here.
--   2. support_owner_consents takes a `route`: `message` (every row so far, his words in his room)
--      or `sign_in` (he confirmed the sign-in core started), and `given_message` is null exactly
--      where the route is `sign_in`.
--   3. support_actions takes the kinds `owner_sign_in` and `owner_signed_in`.
--
-- ROLLBACK (only while no row holds the route `sign_in` or a new kind, and nothing reads the table):
--   DROP TABLE support_owner_sign_ins;
--   ALTER TABLE support_owner_consents DROP CONSTRAINT support_owner_consents_route_chk,
--     DROP COLUMN route, ALTER COLUMN given_message SET NOT NULL;
--   restore support_actions_kind_chk as 0613 wrote it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_owner_sign_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"thread" text NOT NULL,
	"owner_key" text NOT NULL,
	"state_hash" text NOT NULL,
	"verifier_enc" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "support_owner_sign_ins_completed_chk" CHECK (("support_owner_sign_ins"."completed_at" IS NULL) = ("support_owner_sign_ins"."outcome" IS NULL))
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_owner_sign_ins" ADD CONSTRAINT "support_owner_sign_ins_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_owner_sign_ins" ADD CONSTRAINT "support_owner_sign_ins_room_id_support_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "support_owner_sign_ins" ADD CONSTRAINT "support_owner_sign_ins_binding_id_integration_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."integration_bindings"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_owner_sign_ins_state_uq" ON "support_owner_sign_ins" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_owner_sign_ins_project_idx" ON "support_owner_sign_ins" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "support_owner_consents" ADD COLUMN IF NOT EXISTS "route" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_owner_consents" ALTER COLUMN "given_message" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_owner_consents" DROP CONSTRAINT IF EXISTS "support_owner_consents_route_chk";--> statement-breakpoint
ALTER TABLE "support_owner_consents" ADD CONSTRAINT "support_owner_consents_route_chk" CHECK ("support_owner_consents"."route" IN ('message', 'sign_in') AND ("support_owner_consents"."route" = 'message') = ("support_owner_consents"."given_message" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "support_actions" DROP CONSTRAINT IF EXISTS "support_actions_kind_chk";--> statement-breakpoint
ALTER TABLE "support_actions" ADD CONSTRAINT "support_actions_kind_chk" CHECK ("support_actions"."kind" IN ('message_in', 'reply', 'diagnose', 'fix_proposed', 'fix_confirmed', 'fix_ran', 'fix_failed', 'fix_declined', 'fix_expired', 'feedback_recorded', 'progress_posted', 'refused', 'operation', 'channel_written', 'routed', 'announced', 'secret_flagged', 'result_told', 'check_result', 'check_posted', 'promise_made', 'promise_told', 'owner_consented', 'owner_withdrew', 'owner_act', 'owner_sign_in', 'owner_signed_in'));
