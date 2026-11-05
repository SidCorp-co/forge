-- A forge-beta issue is ported as a Feedback item of the same-slug project, not as an open issue
-- (ISS-982, owner 2026-11-05). Its pair names the item in `dev_feedback_id` instead of a dev issue,
-- so `dev_issue_id` takes a null; exactly one of the two is set (`beta_port_pairs_dev_side_chk`).
-- `feedback_told` names the triage outcome (a requirement route, an answer, a decline, a duplicate)
-- already commented on beta, so each is commented once. Every row written before this migration names
-- a dev issue and keeps mirroring as it did. No existing row is rewritten.
--
-- ROLLBACK: DELETE FROM "beta_port_pairs" WHERE "dev_issue_id" IS NULL; then ALTER TABLE
-- "beta_port_pairs" DROP CONSTRAINT IF EXISTS "beta_port_pairs_dev_side_chk", DROP CONSTRAINT IF
-- EXISTS "beta_port_pairs_dev_feedback_id_feedback_id_fk", DROP COLUMN IF EXISTS "feedback_told",
-- DROP COLUMN IF EXISTS "dev_feedback_id", ALTER COLUMN "dev_issue_id" SET NOT NULL. The deleted
-- pairs' beta issues still carry their "Ported to forge-dev: FB-n" comment, which the port reads
-- as already ported; their items stay on dev, unmirrored.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ALTER COLUMN "dev_issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "dev_feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "feedback_told" text;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" DROP CONSTRAINT IF EXISTS "beta_port_pairs_dev_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD CONSTRAINT "beta_port_pairs_dev_feedback_id_feedback_id_fk" FOREIGN KEY ("dev_feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" DROP CONSTRAINT IF EXISTS "beta_port_pairs_dev_side_chk";--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD CONSTRAINT "beta_port_pairs_dev_side_chk" CHECK (("dev_issue_id" IS NULL) <> ("dev_feedback_id" IS NULL));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "beta_port_pairs_dev_feedback_idx" ON "beta_port_pairs" USING btree ("dev_feedback_id");
