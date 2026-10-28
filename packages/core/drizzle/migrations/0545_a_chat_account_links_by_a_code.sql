-- A chat account is linked to a Forge user by a one-time code (REQ-75 r5): the user, signed in to
-- Forge, mints a code, and writes it in a Rocket.Chat room bound to the project from the account to
-- link. The chat server signs who wrote it, so no address has to be read from the chat server (which
-- needs its admin-only `view-full-other-user-info`). Only the code's hash is kept, spent once.
--   speaker_link_codes  new; empty.
--   assistant_speaker_links.confirmed_via  gains `chat_code` in the application's vocabulary (no
--                       database check holds it).
--
-- ROLLBACK: DROP TABLE "speaker_link_codes"; no other table references it.
CREATE TABLE "speaker_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "speaker_link_codes" ADD CONSTRAINT "speaker_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speaker_link_codes" ADD CONSTRAINT "speaker_link_codes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "speaker_link_codes_code_unique" ON "speaker_link_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "speaker_link_codes_user_idx" ON "speaker_link_codes" USING btree ("user_id");
