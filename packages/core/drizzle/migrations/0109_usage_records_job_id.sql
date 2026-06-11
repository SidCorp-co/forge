-- ISS-439 — materialize usage_records from job_events (CLI-runner cost).
-- Add the job_id idempotency key + partial unique index. A job's usage row is
-- inserted ON CONFLICT DO NOTHING, so retries / sweeper-reaped terminals / a
-- re-run of the backfill (0110) can never double-count. Bare uuid (no FK,
-- mirroring jobs.agent_session_id) so job retention/archival can't
-- cascade-delete cost history.
ALTER TABLE "usage_records" ADD COLUMN "job_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_job_id_key" ON "usage_records" ("job_id") WHERE "job_id" IS NOT NULL;
