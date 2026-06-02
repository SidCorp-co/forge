-- Project soft-archive (ISS-353). Adds `projects.archived_at`: NULL = active,
-- a timestamptz = archived. Archived projects drop out of the default project
-- list and stop dispatching new auto-pipeline jobs; their data is fully
-- retained and the action is reversible (unarchive sets the column back to
-- NULL). The index backs the `WHERE archived_at IS NULL` list filter.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0087/0088/0089/0090 headers). The runtime migrator
-- applies this row from _journal.json.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
CREATE INDEX IF NOT EXISTS "projects_archived_at_idx" ON "projects" ("archived_at");
