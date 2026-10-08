-- ISS-1374 — an issue created over REST records the credential it came through.
--
-- `issues.created_via` was 'web' on every REST create, so a create made with a token read as a person
-- at the web UI. Two additions: the channel set gains 'pat' and 'device', and `created_via_token_id`
-- names the token a 'pat', 'device' or 'mcp' create came through (NULL for a session).
--
-- No UPDATE, deliberately. A row written before this reads as it did: 'web' with a NULL token id. No
-- record holds the credential of a past REST create, so rewriting any of them would be a guess, and
-- `VISION: state-never-lies` leaves an attribution that cannot be established as it was found.
--
-- The CHECK is dropped and re-added widened: every existing value is inside the new set,
-- so no row can violate it. The FK is ON DELETE SET NULL, so a deleted token leaves its issues
-- unattributed rather than wrong. The second CHECK is one-directional for that reason: a token id may
-- sit only on a channel a token can come through, but a `pat` row may hold none once its token is gone.
-- Rollback: revert the code and keep this migration — it is additive and old code ignores it. Undoing it would
-- rewrite 'pat' and 'device' rows to 'web', destroying the attribution this adds; if the column must go,
-- export (id, created_via, created_via_token_id) first and drop the index, the FK and the column after that.
ALTER TABLE "issues" ADD COLUMN "created_via_token_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_via_token_id_personal_access_tokens_id_fk" FOREIGN KEY ("created_via_token_id") REFERENCES "public"."personal_access_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_created_via_token_idx" ON "issues" USING btree ("created_via_token_id") WHERE created_via_token_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT "issues_created_via_chk";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_via_chk" CHECK ("issues"."created_via" IS NULL OR "issues"."created_via" IN ('web', 'mcp', 'pipeline', 'schedule', 'system', 'pat', 'device'));--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_via_token_chk" CHECK ("issues"."created_via_token_id" IS NULL OR "issues"."created_via" IN ('pat', 'device', 'mcp'));
