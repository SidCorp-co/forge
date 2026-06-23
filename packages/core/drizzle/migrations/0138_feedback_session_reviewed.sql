-- ISS-557 — surface steward feedback reports in the web UI.
-- Adds session_id (bare uuid, no FK — schedule sessions have no job row)
-- and reviewed_at (owner inbox mark-reviewed) to feedback_reports.
ALTER TABLE "feedback_reports" ADD COLUMN IF NOT EXISTS "session_id" uuid;
ALTER TABLE "feedback_reports" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "feedback_reports_session_id_idx" ON "feedback_reports" ("session_id");
