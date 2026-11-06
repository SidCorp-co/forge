-- ISS-1031. A batch runs one merge check and records its report on each issue it lands
-- (`batch-delivery`), so one check, under the id its script gave it, is recorded on each of those
-- issues. issue_check_runs was keyed by the check id alone, which tied a check to the first issue it
-- was recorded on and refused the batch's second issue CHECK_RUN_CONFLICT. The key becomes
-- (id, issue_id): one check is one row per issue, a resend to an issue already holding it is the
-- same row, and a different check under a recorded id is still refused by the rules
-- (`issues/check-run-rules.ts:sortSentChecks`). No row is rewritten: every existing id is unique,
-- so it is unique with its issue too. The id stays the key's leading column, so a read by id alone
-- still uses the key's index.
--
-- ROLLBACK (only while no id is recorded on two issues):
--   ALTER TABLE "issue_check_runs" DROP CONSTRAINT "issue_check_runs_pkey";
--   ALTER TABLE "issue_check_runs" ADD CONSTRAINT "issue_check_runs_pkey" PRIMARY KEY ("id");

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issue_check_runs" DROP CONSTRAINT IF EXISTS "issue_check_runs_pkey";--> statement-breakpoint
ALTER TABLE "issue_check_runs" ADD CONSTRAINT "issue_check_runs_pkey" PRIMARY KEY ("id", "issue_id");
