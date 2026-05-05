-- ISS-34 — pipeline session zombie fix.
--
-- Adds dispatch/start/heartbeat timestamps + failure_reason so the sweeper
-- can distinguish "queued, waiting for worker" from "running, worker stalled"
-- from "terminal failure". Also backfills the existing zombie set: any
-- pipeline-style session stuck at status='running' with empty messages and
-- no claude_session_id for >5 minutes is a worker that never claimed —
-- transition them to failed so the issue sweeper can recover them.

ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "dispatched_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "failure_reason" text;
--> statement-breakpoint

-- Sweeper queries: find queued/running pipeline sessions older than threshold.
CREATE INDEX IF NOT EXISTS "agent_sessions_status_heartbeat_idx"
  ON "agent_sessions" ("status", "last_heartbeat_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_sessions_status_dispatched_idx"
  ON "agent_sessions" ("status", "dispatched_at");
--> statement-breakpoint

-- Backfill: existing zombies → failed. Restrict to pipeline/pm-typed sessions
-- so we don't disturb interactive chat sessions that may legitimately be
-- mid-stream. Threshold 5min == initial QUEUE_TIMEOUT default.
UPDATE "agent_sessions"
SET "status" = 'failed',
    "failure_reason" = 'migration_zombie_cleanup',
    "updated_at" = NOW()
WHERE "status" = 'running'
  AND "claude_session_id" IS NULL
  AND ("messages" = '[]'::jsonb OR jsonb_array_length("messages") = 0)
  AND "updated_at" < NOW() - interval '5 minutes'
  AND "metadata"->>'type' IN ('pipeline', 'pm');
