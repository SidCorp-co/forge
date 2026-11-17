-- ISS-1251 round 6. From 2026-11-17 12:10Z the steward's lessons pass failed on forge-dev at its first
-- step, every ten minutes: a room reply's failed audit was kept as a correction under
-- `audit:<room>:<chat message id>`, and the pass read every room correction's thread taking that ref
-- as a message uuid, which Postgres refused. Nothing moved for five hours and the only trace was an
-- error line in a container log nobody could read. Each project's last pass is now kept: when it ran,
-- the step it stopped at with its error, its tally and each judge that gave no answer, read on
-- GET /api/projects/:id/metrics/capabilities as `lessonsPass` (`lessons/pass-report.ts`).
-- One row per project, replaced by each pass; nothing else changes.
--
-- ROLLBACK: DROP TABLE IF EXISTS "lessons_pass_reports";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lessons_pass_reports" (
  "project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "stopped_step" text,
  "stopped_error" text,
  "tally" jsonb NOT NULL,
  "unanswered" jsonb NOT NULL,
  CONSTRAINT "lessons_pass_reports_step_chk" CHECK ("stopped_step" IS NULL OR "stopped_step" IN ('gather', 'group', 'settle', 'anchor', 'recheck', 'card-deltas', 'fold', 'retire', 'checks', 'piles', 'months')),
  CONSTRAINT "lessons_pass_reports_stopped_chk" CHECK (("stopped_step" IS NULL) = ("stopped_error" IS NULL))
);
