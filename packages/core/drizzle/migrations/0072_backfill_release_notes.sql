-- ISS-199 — backfill: lift any pre-existing `## Release notes` section out of
-- `issues.description` into the new `release_notes` jsonb column, then strip
-- the section from description so the markdown body belongs to the developer
-- only. Idempotent — re-running is a no-op because:
--   * the WHERE clause skips rows that already have `release_notes IS NOT NULL`
--   * a description that has already been stripped no longer matches
--     `~* '## Release notes'`.
--
-- The clarify-side description-block workaround was never merged to main, so
-- in practice this migration will usually match zero rows in production —
-- it ships as a defensive net for any environment that ran an unmerged
-- branch of the workaround skill and accumulated `## Release notes` sections
-- in issue descriptions before the typed field landed.
WITH parsed AS (
  SELECT
    id,
    description,
    substring(description from '## Release notes[\s\S]*?(?=\n## |\n*$)') AS block
  FROM issues
  WHERE release_notes IS NULL
    AND description ~* '## Release notes'
),
extracted AS (
  SELECT
    id,
    description,
    substring(block from '\*\*Section:\*\*\s+(Added|Changed|Fixed|Removed|Security|Skip)') AS section,
    substring(block from '\*\*User-facing:\*\*\s+([^\n]+)') AS user_facing,
    substring(block from '\*\*Technical:\*\*\s+([^\n]+)') AS technical
  FROM parsed
)
UPDATE issues i
SET
  release_notes = jsonb_build_object(
    'section', COALESCE(e.section, 'Skip'),
    'userFacing', COALESCE(NULLIF(e.user_facing, ''), '-'),
    'technical', NULLIF(e.technical, '')
  ),
  description = regexp_replace(
    i.description,
    E'\\n*## Release notes[\\s\\S]*?(?=(\\n## |$))',
    '',
    'gi'
  )
FROM extracted e
WHERE i.id = e.id;
