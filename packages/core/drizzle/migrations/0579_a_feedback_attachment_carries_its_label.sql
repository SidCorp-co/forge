-- A file attached to an existing feedback item may be marked as an approved design (ISS-879), so the
-- mockups a person approved reach the item and are read as such. Null on every row before it.
--
-- ROLLBACK: drop the constraint and the column.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD COLUMN IF NOT EXISTS "label" text;--> statement-breakpoint
ALTER TABLE "feedback_attachments" DROP CONSTRAINT IF EXISTS "feedback_attachments_label_chk";--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD CONSTRAINT "feedback_attachments_label_chk" CHECK ("label" IS NULL OR "label" IN ('approved_design'));
