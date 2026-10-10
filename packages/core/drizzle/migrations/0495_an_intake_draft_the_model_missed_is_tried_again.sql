-- An intake draft the model missed is tried again (REQ-34 BC-10; ISS-455, release judge J8 on
-- FB-123). A provider timeout or an unconfigured model was kept as a miss and called retryable,
-- but nothing delivered the item again, so one timeout left it undrafted for good. The outbox now
-- delivers it again with its backoff, up to three tries, and the draft records whether another try
-- is owed, so its page says retrying or gave up rather than guessing from the count.
--
-- No row is backfilled: a miss kept before this has no delivery left to try it again, and false
-- says exactly that.
--
-- ROLLBACK: drop the check and the column; drafts then read as never retried.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD COLUMN IF NOT EXISTS "retry_owed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "intake_drafts" DROP CONSTRAINT IF EXISTS "intake_drafts_retry_chk";--> statement-breakpoint
ALTER TABLE "intake_drafts" ADD CONSTRAINT "intake_drafts_retry_chk" CHECK (NOT "intake_drafts"."retry_owed" OR "intake_drafts"."outcome" = 'failed');
