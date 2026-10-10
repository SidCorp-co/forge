-- A feedback item the record cannot verify says why (REQ-34 BC-1; Feedback lifecycle r14
-- loop-check; Feedback triage r16 auto-verify). Past its verify window, an item whose violated
-- criterion does not pass on the running build, or which names none, stays resolved for a holder
-- of feedback.approve. The sweep counted it held and wrote nothing, so the item said nothing about
-- why it was not verified. It now writes when it found that and why.
--
-- No row is backfilled: the next sweep writes each held item past its window, from the record.
--
-- ROLLBACK: drop the check and both columns, which loses each item's recorded reason.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "verify_held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "verify_held_why" text;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_verify_held_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_verify_held_chk" CHECK (("feedback"."verify_held_at" IS NULL) = ("feedback"."verify_held_why" IS NULL));
