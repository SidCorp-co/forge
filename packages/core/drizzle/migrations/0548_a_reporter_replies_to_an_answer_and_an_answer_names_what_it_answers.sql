-- A reporter replies once to each answer, with evidence, and the reply sends the item back to triage
-- as a reopen does (REQ-47 BC-12): decision `replied`, which carries its words like a reopen. An
-- answer to a reopened item names the reopen or reply it answers (BC-13): `in_reply_to`, the id of
-- that decision, set only on a triaged decision that took the answer route.
-- No row is rewritten: every decision written before this one answered nothing by name.
--
-- ROLLBACK: ALTER TABLE feedback_decisions DROP CONSTRAINT feedback_decisions_in_reply_to_chk,
--   DROP COLUMN in_reply_to; and restore decision_chk and reason_chk without 'replied' (0441).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD COLUMN IF NOT EXISTS "in_reply_to" uuid;--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT IF EXISTS "feedback_decisions_in_reply_to_feedback_decisions_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_in_reply_to_feedback_decisions_id_fk" FOREIGN KEY ("in_reply_to") REFERENCES "public"."feedback_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_decision_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_decision_chk" CHECK ("feedback_decisions"."decision" IN ('triaged', 'declined', 'verified', 'reopened', 'replied', 'redacted', 'promoted', 'routed', 'retargeted', 'accepted', 'snoozed'));--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_reason_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_reason_chk" CHECK ("feedback_decisions"."decision" NOT IN ('declined', 'reopened', 'replied', 'snoozed') OR "feedback_decisions"."reason" ~ '[^[:space:]]');--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT IF EXISTS "feedback_decisions_in_reply_to_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_in_reply_to_chk" CHECK ("feedback_decisions"."in_reply_to" IS NULL OR ("feedback_decisions"."decision" = 'triaged' AND "feedback_decisions"."route" = 'answer'));
