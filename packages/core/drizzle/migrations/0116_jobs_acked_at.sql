-- ISS-449 (ISS-442 C3 / invariant I3) — runner ACK timestamp.
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0087-0091).
-- Stamped by POST /api/jobs/:id/ack when the runner claims the job, or as a
-- fallback by the first job_event batch. The loop monitor's dispatch→ack hop
-- (jobs/loop-monitor.ts) reaps dispatched rows that never get one. Idempotent.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "acked_at" timestamp with time zone;
