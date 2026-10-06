-- The read-time alias contracts failure-causes.ts kept for two retired cause spellings is deleted
-- (audit 5), so the stored rows are rewritten to the cause each already read as:
--   job_failed  -> unclassified          (the literal ISS-877 replaced; 0192 left its rows to the alias)
--   usage_limit -> provider_usage_limit
-- Only agent_sessions.failure_reason and jobs.failure_reason are read as a failure cause
-- (resolveFailureCause). Other columns hold the same spellings in other vocabularies and are left
-- alone: kernel_transitions.reason `job_failed` is the session move's reason (`job_<outcome>`), and
-- a runner limit or a master pass refusal reads `usage_limit` as its own reason.
--
-- ROLLBACK: none for the contents; each rewritten row reads exactly as it did through the alias.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE "agent_sessions" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "jobs" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "agent_sessions" SET "failure_reason" = 'unclassified' WHERE "failure_reason" = 'job_failed';--> statement-breakpoint
UPDATE "agent_sessions" SET "failure_reason" = 'provider_usage_limit' WHERE "failure_reason" = 'usage_limit';--> statement-breakpoint
UPDATE "jobs" SET "failure_reason" = 'unclassified' WHERE "failure_reason" = 'job_failed';--> statement-breakpoint
UPDATE "jobs" SET "failure_reason" = 'provider_usage_limit' WHERE "failure_reason" = 'usage_limit';
