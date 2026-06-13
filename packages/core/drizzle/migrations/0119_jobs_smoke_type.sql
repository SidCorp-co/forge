-- ISS-455 (Onboarding C2) — `smoke` job kind for per-project skill smoke-verify
-- canaries (tier-2). Hand-written migration (applied from meta/_journal.json;
-- drizzle-kit generate is blocked by the pre-existing meta snapshot collision,
-- see 0087-0091).
--
-- `jobs.type` is plain `text NOT NULL` with no DB-level CHECK constraint
-- (verified back in 0041 when `pm` was added the same way), so the enum
-- extension itself lives only in `db/schema.ts` — no ALTER needed here.
--
-- The partial index serves the smoke-verify report's "latest canary per stage"
-- read (`WHERE project_id = $1 AND type = 'smoke' ORDER BY queued_at DESC`)
-- without scanning the hot jobs table. Idempotent.
CREATE INDEX IF NOT EXISTS "jobs_smoke_project_queued_idx"
  ON "jobs" ("project_id", "queued_at")
  WHERE "type" = 'smoke';
