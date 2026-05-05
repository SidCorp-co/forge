-- ISS-34 retry — defensive re-apply of 0042.
--
-- Background: 0042_agent_sessions_zombie_fix.sql shipped without an entry
-- in drizzle/migrations/meta/_journal.json. drizzle-orm's migrator only
-- applies migrations registered in the journal, so 0042 was silently
-- skipped on every container start. This file is fully idempotent
-- (ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS + a guarded
-- UPDATE) so it's safe to run on databases that already have the columns
-- as well as those that don't.

ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_sessions_status_heartbeat_idx"
  ON "agent_sessions" ("status", "last_heartbeat_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_sessions_status_dispatched_idx"
  ON "agent_sessions" ("status", "dispatched_at");
--> statement-breakpoint

UPDATE "agent_sessions"
SET "status" = 'failed',
    "failure_reason" = 'migration_zombie_cleanup',
    "updated_at" = NOW()
WHERE "status" = 'running'
  AND "claude_session_id" IS NULL
  AND ("messages" = '[]'::jsonb OR jsonb_array_length("messages") = 0)
  AND "updated_at" < NOW() - interval '5 minutes'
  AND "metadata"->>'type' IN ('pipeline', 'pm');
