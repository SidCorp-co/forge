-- A person adds a common issue on a bound channel's page (ISS-1184): a question and its one answer,
-- naming no thread, because a person knows the question keeps coming without the session having
-- seen it asked twice. The session's common issue still names at least two threads (BC-36, held in
-- `noteCommonIssue` too); a row naming exactly one is neither, and stays refused.
--
-- Backfill: none. Every row so far names two threads or more, which the new check admits.
--
-- ROLLBACK: DELETE FROM "support_channel_common_issues" WHERE cardinality("threads") = 0; ALTER TABLE "support_channel_common_issues" DROP CONSTRAINT "support_channel_common_issues_threads_chk"; ALTER TABLE "support_channel_common_issues" ADD CONSTRAINT "support_channel_common_issues_threads_chk" CHECK (cardinality("threads") >= 2);

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_channel_common_issues" DROP CONSTRAINT IF EXISTS "support_channel_common_issues_threads_chk";--> statement-breakpoint
ALTER TABLE "support_channel_common_issues" ADD CONSTRAINT "support_channel_common_issues_threads_chk" CHECK (cardinality("threads") >= 2 OR cardinality("threads") = 0);
