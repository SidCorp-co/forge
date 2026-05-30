-- Per-device repo path on the runners row (ISS-271).
--
-- Moves the repo checkout path + branch from the single project-wide
-- `projects.repo_path` hint to the (device × project) `runners` row, which is
-- the correct grain: each device checks the project out at its own path. This
-- becomes the server source of truth — written by web (PATCH
-- /:id/runners/:runnerId) or CLI (`forge-runner bind <slug> --path <dir>`),
-- and read by the runner daemon via GET /api/devices/me/runners.
--
-- Both columns are nullable: a freshly web-bound device has a runner row with
-- no path yet (the daemon warns and refuses to route jobs until set).
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0080_upload_tickets / 0081_issue_step_contexts
-- headers). The runtime migrator applies this row from _journal.json.

ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "repo_path" text;
ALTER TABLE "runners" ADD COLUMN IF NOT EXISTS "branch" text;
