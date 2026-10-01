-- A checkout is a path on one box, so the device binding (`runners.repo_path`) is the only place one
-- is named, and no box is a project's default (ISS-14). Both project columns are dropped, not
-- migrated (design D8). Dropping `default_device_id` takes its foreign key and its index with it:
-- the key was declared inline by 0035, so it carries Postgres's own name, not drizzle's.

ALTER TABLE "projects" DROP COLUMN "repo_path";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "default_device_id";
