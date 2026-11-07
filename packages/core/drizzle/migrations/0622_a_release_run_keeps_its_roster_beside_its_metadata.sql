-- A release run keeps the four roster lists its holding rule reads in a small column of their own
-- (ISS-1070). `issues/release-evidence.ts:holdingReleaseRunsSql` asks of every shipped release run
-- of a project whether its roster holds an issue, once per issue it is asked about, and read the
-- lists out of `metadata`, which on a release run carries its cuts, verification and naming and is
-- stored out of line: each ask detoasted the whole document four times. On forge-dev (540 releases)
-- the shipped-release read of one Needs you request took 1.7 s, 1.36 million buffer reads, twice.
--
-- The column is generated from `metadata`, so Postgres keeps it right on every write that changes
-- the lists and no reader or writer owns a copy. It is NULL on every run that wears no version.
--
-- ROLLBACK: -- `jsonb_build_object` is only stable, and a generated column takes immutable functions alone, so
-- the object is built by `jsonb_set`, which is immutable.
ALTER TABLE "pipeline_runs" ADD COLUMN IF NOT EXISTS "release_roster" jsonb
  GENERATED ALWAYS AS (
    CASE WHEN "release_version" IS NOT NULL THEN
      jsonb_set(jsonb_set(jsonb_set(jsonb_set('{}'::jsonb,
        '{issueIds}', coalesce("metadata" -> 'issueIds', '[]'::jsonb)),
        '{rosterUnclosed}', coalesce("metadata" -> 'rosterUnclosed', '[]'::jsonb)),
        '{rosterClosed}', coalesce("metadata" -> 'rosterClosed', '[]'::jsonb)),
        '{rosterSuperseded}', coalesce("metadata" -> 'rosterSuperseded', '[]'::jsonb))
    END
  ) STORED;
