# Bundled forge-* skills

Source of truth for the 8 built-in pipeline skills seeded into the `skills`
table on server start (see `src/skills/builtin-seed.ts`). Edit SKILL.md files
here; do not edit the copies under the repo-root `.claude/skills/` path — those
are agent-workspace artifacts, not the shipped artifact.

Seeder is idempotent: a SKILL.md change bumps `content_hash`, which triggers an
UPDATE with `version` incremented on next boot.
