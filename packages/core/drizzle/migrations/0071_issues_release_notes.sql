-- ISS-199 — typed release-notes column on `issues`. Written by forge-clarify
-- (per-issue) and read by forge-release at close time to append a bullet to
-- CHANGELOG.md `## [Unreleased]`. Shape is validated at the application
-- layer (zod `ReleaseNotesSchema` in `@forge/core/public`, re-exported from
-- `@forge/contracts`) so the enum can grow without further migrations.
ALTER TABLE issues ADD COLUMN release_notes jsonb;
