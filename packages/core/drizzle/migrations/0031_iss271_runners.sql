-- ISS-271 (v1 EPIC 2) — Runner framework.
-- Adds the `runners` table + `jobs.runner_id` FK.
-- EPIC 2 owns this schema. EPIC 3 Phase B (ISS-272 follow-up) layers admin
-- dashboard reads on top — do not redesign these columns there.

-- Note: drizzle's text() with enum constraint emits a CHECK constraint, so
-- the columns are plain text. We rely on the application + drizzle types for
-- enum enforcement; this matches the existing `device_statuses`, `job_statuses`,
-- and `job_event_kinds` columns in earlier migrations.

CREATE TABLE IF NOT EXISTS "runners" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "type" text NOT NULL,
  "host" text NOT NULL,
  "device_id" uuid,
  "name" text NOT NULL,
  "labels" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "capabilities" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'offline',
  "last_seen_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "runners_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "runners_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL,
  CONSTRAINT "runners_type_chk" CHECK ("type" IN ('claude-code','antigravity')),
  CONSTRAINT "runners_host_chk" CHECK ("host" IN ('device','remote')),
  CONSTRAINT "runners_status_chk" CHECK ("status" IN ('online','offline','draining','disabled'))
);

COMMENT ON TABLE "runners" IS
  'EPIC 2 (ISS-271) owns schema. EPIC 3 Phase B (ISS-272 follow-up) layers admin dashboard reads on top.';

CREATE INDEX IF NOT EXISTS "runners_project_type_status_idx"
  ON "runners" ("project_id", "type", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "runners_device_type_uq"
  ON "runners" ("device_id", "type") WHERE "device_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "runners_remote_name_uq"
  ON "runners" ("project_id", "type", "name") WHERE "host" = 'remote';

ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "runner_id" uuid;

ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_runner_id_fkey" FOREIGN KEY ("runner_id") REFERENCES "runners"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "jobs_runner_id_idx" ON "jobs" ("runner_id");
