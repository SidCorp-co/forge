-- A member's message in a bound room's thread that follows the bot's reply is read for a correction
-- the way a chat reply is (ISS-867, REQ-50 BC-1): source `room`, about the thread's conversation,
-- with the classifier's score as a chat correction carries one. The source check gains `room`, the
-- score check reads `room` as scored, and the outbox gains the event the lessons module reads,
-- `room.replied`. No stored row is a `room` correction, so none can fail either check.
--
-- ROLLBACK: delete the `room` corrections, then restore both checks as 0578 and 0510 wrote them;
-- DELETE FROM outbox_event_types WHERE type = 'room.replied', once no pipeline_outbox row names it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_source_chk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_source_chk" CHECK ("corrections"."source" IN ('mockup_returned', 'mockup_accepted', 'suggestion_rejected', 'design_returned', 'revision_returned', 'verdict_failed', 'chat', 'room', 'feedback_triaged', 'feedback_declined'));--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_score_chk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_score_chk" CHECK (("corrections"."source" IN ('chat', 'room')) = ("corrections"."score" IS NOT NULL) AND ("corrections"."score" IS NULL OR "corrections"."score" BETWEEN 0 AND 1));--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('room.replied') ON CONFLICT DO NOTHING;
