-- A drafted release can be named before it is cut (REQ-40 BC-14). Its name and summary wait here,
-- one row per project and version, until the cut that takes the version carries them onto its run's
-- `metadata.naming` and deletes the row. A release cut with a name never had a row.
--
-- ROLLBACK: drop the table once every draft named here was cut or renamed at its cut.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_draft_namings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "version" text NOT NULL,
  "name" text NOT NULL,
  "summary" text NOT NULL,
  "named_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "named_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_draft_namings_project_version_uq" ON "release_draft_namings" ("project_id", "version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_draft_namings_project_idx" ON "release_draft_namings" ("project_id");
