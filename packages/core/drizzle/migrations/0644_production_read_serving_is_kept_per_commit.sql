-- Each whole commit a project's production was read serving, with when it was first and last read so
-- (ISS-1182, FB-592). On forge-dev every push deploys, and after each deploy no pair the
-- served-ancestry pass asked names the new live commit, so every verdict commit no release record
-- placed read as not judged until the pass had asked each pair again: REQ-12 read 8/23 right after
-- dev.619 deployed and 21/23 four minutes later. With the build served before named here, a verdict
-- that build held keeps its answer, marked as re-checked, until the host says whether the new build
-- descends from it, and the pass asks that one pair a deploy rather than one a commit.
--
-- A record of readings, never what is served now (ISS-1286): no row is read as the live build.
-- Nothing to backfill: the pass writes the commit each project serves on its next run.
--
-- ROLLBACK: DROP TABLE IF EXISTS "served_builds";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "served_builds" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "commit" text NOT NULL,
  "first_read_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "served_builds_project_id_commit_pk" PRIMARY KEY ("project_id", "commit"),
  CONSTRAINT "served_builds_whole_chk" CHECK ("commit" ~ '^[0-9a-f]{40}$')
);
