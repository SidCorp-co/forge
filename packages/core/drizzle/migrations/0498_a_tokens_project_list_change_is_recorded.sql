-- A personal token's project list can be changed after mint, and every change is recorded (FB-48).
-- The Access tokens screen adds or removes a project on a live token without minting a new secret;
-- each change keeps who made it and the list before and after, so the reach a token had at any time
-- can be read back.
--
-- No row is backfilled: changes made through the door before this table existed were not kept.
--
-- ROLLBACK: drop the table; changes then go unrecorded.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_fence_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL REFERENCES "personal_access_tokens"("id") ON DELETE CASCADE,
	"user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"before_projects" uuid[],
	"after_projects" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_fence_changes_token_idx" ON "token_fence_changes" ("token_id","created_at");
