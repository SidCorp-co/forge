-- Adds a per-project jsonb blob for preview/staging deploy + testing config.
--
-- Shape (free-form jsonb, mirrored by `previewDeployPatchSchema` in
-- packages/core/src/projects/routes.ts):
--   { stagingUrl?, stagingApiUrl?, testingUrls?: [{label,url}],
--     testCredentials?: [{label,username,password}], … }
--
-- NULL = project has no staging/testing config; readers must treat absence
-- as "local-only mode" (see packages/core/skills/forge-test).
--
-- Rollback: ALTER TABLE projects DROP COLUMN preview_deploy; — data lost.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "preview_deploy" jsonb;
