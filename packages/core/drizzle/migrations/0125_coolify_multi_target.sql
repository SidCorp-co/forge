-- ISS (SidPeak Coolify refactor) — fold the single `{resourceUuid, branch}` deploy
-- target on each Coolify binding into a `targets[]` array so one project+environment
-- can deploy several Coolify applications (e.g. a split backend + frontend).
--
-- Hand-written data migration (applied via meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0087-0091). The jsonb
-- columns themselves need no DDL change — only the stored shape moves:
--   binding.config: { resourceUuid, branch } -> { targets: [{ id, label, resourceUuid }] }
-- The effective resourceUuid may have been inherited off the shared connection
-- (binding had none of its own), so we COALESCE binding -> connection. `branch` is
-- dropped: it was never sent to Coolify's deploy API (uuid + force only). Idempotent
-- (only rewrites rows that don't already carry `targets`).

UPDATE "integration_bindings" b
SET "config" = (b."config" - 'resourceUuid' - 'branch') || jsonb_build_object(
  'targets', jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'label', 'App',
    'resourceUuid', COALESCE(b."config"->>'resourceUuid', c."config"->>'resourceUuid')
  ))
)
FROM "integration_connections" c
WHERE b."connection_id" = c."id"
  AND b."provider" = 'coolify'
  AND NOT (b."config" ? 'targets')
  AND COALESCE(b."config"->>'resourceUuid', c."config"->>'resourceUuid') IS NOT NULL;

-- Strip the now-migrated single-target keys from the shared connection config so the
-- credential row holds only connection-tier fields (baseUrl).
UPDATE "integration_connections"
SET "config" = "config" - 'resourceUuid' - 'branch'
WHERE "provider" = 'coolify'
  AND ("config" ? 'resourceUuid' OR "config" ? 'branch');
