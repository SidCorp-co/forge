-- A repeat report joins the open item as an occurrence with what it said and its screenshot, and a
-- screenshot carries the reporter's word that it was redacted (ISS-694, REQ-66 BC-3, BC-7).
--
-- feedback_occurrences: `said` is what the repeat's reporter said, scrubbed on write as the item's own
-- text is; `attachment_id` is the screenshot taken with it, one of the item's attachments, set null
-- when that attachment goes with a redaction. Rows written before hold NULL for both: the Forge door's
-- occurrences said nothing beyond their item, and none carried a screenshot. Nothing is backfilled.
-- feedback_attachments: `redacted` is the reporter's word that nothing personal shows in the bytes. Every
-- row written before reads false, so on a project that redacts its bytes are withheld from models from
-- now on, which is what no scrubber reading an image owes them.
--
-- ROLLBACK: drop feedback_occurrences.attachment_id and .said, losing which screenshot came with which
-- repeat and what each said; drop feedback_attachments.redacted, after which a redact project's
-- screenshots reach models again unread.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "feedback_attachments" ADD COLUMN IF NOT EXISTS "redacted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD COLUMN IF NOT EXISTS "said" text;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD COLUMN IF NOT EXISTS "attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" DROP CONSTRAINT IF EXISTS "feedback_occurrences_attachment_id_feedback_attachments_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD CONSTRAINT "feedback_occurrences_attachment_id_feedback_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."feedback_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" DROP CONSTRAINT IF EXISTS "feedback_occurrences_said_chk";--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD CONSTRAINT "feedback_occurrences_said_chk" CHECK ("feedback_occurrences"."said" IS NULL OR "feedback_occurrences"."said" ~ '[^[:space:]]');
