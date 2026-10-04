-- A release version may carry a prerelease tail, `0.4.0-dev.1`, for a project whose document declares
-- `release.prerelease` (`release-batch/version.ts`). The CHECK widens to that shape and nothing else,
-- so every value it held before still holds, and every value it admits now parses.
--
-- The way back: drop the constraint and re-add it with the 0294 shape, which Postgres refuses while
-- any prerelease row is stored — those are releases, and are not rewritten to fit.
ALTER TABLE "pipeline_runs" DROP CONSTRAINT "pipeline_runs_release_version_chk";--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_release_version_chk" CHECK ("pipeline_runs"."release_version" IS NULL OR "pipeline_runs"."release_version" ~ '^[0-9]{1,9}[.][0-9]{1,9}[.][0-9]{1,9}(-[a-z][a-z0-9]{0,15}[.][0-9]{1,9})?$');
