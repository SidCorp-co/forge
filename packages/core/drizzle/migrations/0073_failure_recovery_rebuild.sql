-- ISS-197 — Failure recovery rebuild: Retry-After parser, recoveryStats,
-- recovery-by-verification.
--
-- 1. jobs.retry_after_at: dispatch gate L1 skips queued rows with a future
--    timestamp; NULL = ready to dispatch. Populated by the new retry engine
--    when it honours a provider Retry-After header.
-- 2. agent_sessions.status gains two non-failure terminal markers
--    (`completed_via_recovery`, `cancelled_stale`) so the verifier can mark a
--    failed session as recovered without faking a `completed` row.
-- 3. jobs.failure_kind enum widens to {transient,permission,permanent,
--    timeout,unknown}; classifier v2 distinguishes auth/perm errors from
--    permanent and timeout errors from transient.

ALTER TABLE "jobs"
  ADD COLUMN "retry_after_at" timestamptz NULL;--> statement-breakpoint

COMMENT ON COLUMN "jobs"."retry_after_at" IS
  'When set, L1 dispatch gate skips this row until now() >= retry_after_at. NULL = ready to dispatch.';--> statement-breakpoint

CREATE INDEX "jobs_retry_after_idx"
  ON "jobs" ("retry_after_at")
  WHERE "status" = 'queued' AND "retry_after_at" IS NOT NULL;--> statement-breakpoint

-- agent_sessions.status — drop-and-recreate the implicit CHECK constraint so
-- the new terminal markers are accepted. Drizzle `text({enum})` columns do
-- not own the CHECK at the DB level (Drizzle enforces in TS), so emit an
-- explicit constraint here as a defence-in-depth against raw SQL writers.
ALTER TABLE "agent_sessions"
  DROP CONSTRAINT IF EXISTS "agent_sessions_status_check";--> statement-breakpoint

ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_status_check"
  CHECK ("status" IN ('idle','queued','running','completed','failed','completed_via_recovery','cancelled_stale'));--> statement-breakpoint

ALTER TABLE "jobs"
  DROP CONSTRAINT IF EXISTS "jobs_failure_kind_check";--> statement-breakpoint

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_failure_kind_check"
  CHECK ("failure_kind" IS NULL OR "failure_kind" IN ('transient','permission','permanent','timeout','unknown'));
