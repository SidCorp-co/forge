-- A decision is withdrawn, never deleted, and a comment keeps the intent each edit left (ISS-585,
-- REQ-33 BC-2, FB-151).
--
-- activity_log: `record.withdrawal` joins the closed set of record kinds. Core writes one when a
-- decision is withdrawn (`POST /api/issues/:id/events/:eventId/withdraw`), naming the decision, who
-- withdrew it and why; the decision row stays as written. `activity_log_record_withdrawal_uq` keeps
-- one withdrawal per record (dedupe key `record-withdrawal:<record id>`). No row is moved.
-- comment_events: `intent` is the intent as it stood after the post or edit, so an intent correction
-- is kept like a body edit. Rows written before hold NULL, read as "not kept": nothing is backfilled,
-- since no row recorded what the intent was then.
--
-- ROLLBACK: delete every `record.withdrawal` row first (the withdrawn decisions are then read as
-- standing again), re-add the check without it, drop the index; drop comment_events.intent with its
-- check, losing the intent each edit recorded.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_record_kind_chk";--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_record_kind_chk" CHECK ("activity_log"."action" NOT LIKE 'record.%' OR "activity_log"."action" IN ('record.verdict', 'record.transition', 'record.landing', 'record.park', 'record.correction', 'record.fold', 'record.routed', 'record.gap', 'record.baseline', 'record.decision', 'record.question', 'record.answer', 'record.confirmation', 'record.superseded', 'record.review', 'record.finding', 'record.triage', 'record.folded', 'record.declined', 'record.wave', 'record.verification', 'record.withdrawal', 'record.digest'));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_record_withdrawal_uq" ON "activity_log" USING btree ("dedupe_key") WHERE "activity_log"."dedupe_key" LIKE 'record-withdrawal:%';--> statement-breakpoint
ALTER TABLE "comment_events" ADD COLUMN IF NOT EXISTS "intent" text;--> statement-breakpoint
ALTER TABLE "comment_events" DROP CONSTRAINT IF EXISTS "comment_events_intent_chk";--> statement-breakpoint
ALTER TABLE "comment_events" ADD CONSTRAINT "comment_events_intent_chk" CHECK ("comment_events"."intent" IS NULL OR "comment_events"."intent" IN ('question', 'decision', 'note'));
