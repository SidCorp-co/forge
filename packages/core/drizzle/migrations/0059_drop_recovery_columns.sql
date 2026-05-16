-- Drop legacy recovery tracking + retry cap columns.
--
-- The failure model is now operator-driven via setManualHoldBlock — the
-- sweeper recovery branch + 3-attempt retry chain were removed in the
-- preceding PR. These columns no longer have readers or writers.
--
-- - issues.recovery_attempts, last_recovery_at, recovery_window_started_at
--     used by the pipeline-sweeper to apply per-issue recovery budget.
--     Recovery now requires explicit operator action (clear manualHold).
--
-- - jobs.max_attempts
--     used by retry.ts to cap exponential backoff chain. New retry.ts
--     hardcodes MAX_AUTO_RETRIES = 1 in code.

DROP INDEX IF EXISTS "issues_pipeline_recovery_idx";

ALTER TABLE "issues" DROP COLUMN IF EXISTS "recovery_attempts";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "last_recovery_at";
ALTER TABLE "issues" DROP COLUMN IF EXISTS "recovery_window_started_at";

ALTER TABLE "jobs" DROP COLUMN IF EXISTS "max_attempts";
