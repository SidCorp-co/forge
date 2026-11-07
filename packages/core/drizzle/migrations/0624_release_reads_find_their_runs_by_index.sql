-- The release reads find a project's release runs by index (ISS-1070 r4). Every reader of releases
-- asks a project's runs that wear a version, and a project's issue runs outnumber them four to one on
-- forge-dev: the plan read every run of the project and threw the rest away. A person's home and
-- attention ask each of their projects in turn, so that waste was paid once a project.
--
-- `release_runs`: a project's versioned runs, in cut order (`version-store.ts:readLineageRuns`, the
-- release lists and the shipped releases).
-- `release_records`: the landing records that closed an issue (`landed-build.ts:recordedLandings`),
-- which matched no project and read every run in the table, about 7,000 buffers each ask.
-- `release_commit`: the release a build is, by its commit or an abbreviation of it
-- (`shipped-releases.ts:shippedReleaseRuns`, What's new).
--
-- ROLLBACK: DROP INDEX IF EXISTS "pipeline_runs_release_runs_idx", "pipeline_runs_release_records_idx", "pipeline_runs_release_commit_idx";
CREATE INDEX IF NOT EXISTS "pipeline_runs_release_runs_idx" ON "pipeline_runs" ("project_id", "started_at")
  WHERE "release_version" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_release_records_idx" ON "pipeline_runs" ("project_id", "started_at")
  WHERE ("metadata" ->> 'source') = 'release-record';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_release_commit_idx" ON "pipeline_runs"
  ("project_id", lower(btrim("metadata" -> 'finish' ->> 'commit')) text_pattern_ops)
  WHERE ("metadata" ->> 'source') = 'release-batch' AND "release_version" IS NOT NULL
    AND "release_released_at" IS NOT NULL;
