-- A feedback item is a correction a lesson learns from (ISS-867, REQ-50 BC-1). A bug or change
-- request triaged onto work says what the product or an agent got wrong (`feedback_triaged`, said by
-- its reporter), and a decline with a reason says what the report itself got wrong
-- (`feedback_declined`, said by the triager); both are about the item, kind `feedback`. The two
-- checks gain the new values; no row changes.
--
-- ROLLBACK: delete the rows of the two sources, then restore both checks as 0510 wrote them.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_source_chk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_source_chk" CHECK ("corrections"."source" IN ('mockup_returned', 'mockup_accepted', 'suggestion_rejected', 'design_returned', 'revision_returned', 'verdict_failed', 'chat', 'feedback_triaged', 'feedback_declined'));--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_item_kind_chk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_item_kind_chk" CHECK ("corrections"."item_kind" IN ('mockup', 'suggestion', 'workflow', 'requirement', 'issue', 'conversation', 'feedback'));
