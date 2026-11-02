-- A shipped agent-reported item's confirm may wait on a date or an event, with a reason (ISS-902,
-- FB-480). `masters/owed-confirms.ts` named every such item on every pass until verified or reopened,
-- even one only a future event can test (the owner's next message in a room). The wait is the
-- record of why it waits: out of the master's owed line until `confirm_wait_until`, or until the event
-- `confirm_wait_on` names happens (`confirm_wait_met_at`), whichever comes first.
--
-- Only new nullable columns and a check every existing row satisfies (all null). ROLLBACK: drop the
-- check and the six columns; any wait set is lost and its item is named on every pass again.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_on" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_reason" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_set_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_met_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_confirm_wait_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_confirm_wait_chk" CHECK (("confirm_wait_until" IS NULL) = ("confirm_wait_reason" IS NULL) AND ("confirm_wait_until" IS NULL) = ("confirm_wait_set_at" IS NULL) AND ("confirm_wait_reason" IS NULL OR "confirm_wait_reason" ~ '[^[:space:]]') AND ("confirm_wait_on" IS NULL OR ("confirm_wait_until" IS NOT NULL AND "confirm_wait_on" IN ('room_message'))) AND ("confirm_wait_met_at" IS NULL OR "confirm_wait_on" IS NOT NULL));
