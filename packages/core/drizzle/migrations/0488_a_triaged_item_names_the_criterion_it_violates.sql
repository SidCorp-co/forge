-- A triaged feedback item names the business criterion it violates (REQ-34 BC-6; Feedback lifecycle
-- r14 triage-check and loop-check).
--
-- feedback.violated_criterion_id: the criterion the triage checklist's "Which business criterion
-- does it violate, or none?" named, written by the triage act; NULL where it answered none or no
-- triage has run since this column existed. Loop close reads that criterion's latest verdict before
-- it verifies an item nobody confirmed. Nothing is backfilled: no triage before this one asked the
-- question, so no older item has an answer to carry. A criterion row deleted with its requirement
-- leaves the item naming none.
--
-- ROLLBACK: drop feedback.violated_criterion_id with its index; the criteria triages named are then
-- gone, and loop close can no longer answer from the record.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "violated_criterion_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_violated_criterion_id_requirement_criteria_id_fk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_violated_criterion_id_requirement_criteria_id_fk" FOREIGN KEY ("violated_criterion_id") REFERENCES "public"."requirement_criteria"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_violated_criterion_idx" ON "feedback" ("violated_criterion_id") WHERE "violated_criterion_id" IS NOT NULL;
