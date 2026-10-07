-- A runner held by its account's refusal said only how long it was held, and that end was the reset
-- the account printed ("resets 2:30am"), which the screens read as when work resumes. FB-87: the
-- account printed 19:30Z and answered at 16:42Z. rate_limited_until now means the next try, and the
-- refusal keeps two facts beside it: when it happened, and the reset the account printed, as the
-- account's claim. NULL on both where no limit is held, or for a limit stamped before this.
--
-- ROLLBACK: ALTER TABLE runners DROP COLUMN limit_refused_at, DROP COLUMN limit_printed_reset_at.

ALTER TABLE "runners" ADD COLUMN "limit_refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "limit_printed_reset_at" timestamp with time zone;
