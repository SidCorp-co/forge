# Bundled forge-* skills

Source of truth for the built-in pipeline skills seeded into the `skills` table
on server start (see `src/skills/builtin-seed.ts`). The set is whatever
subdirectories exist here — `ls -d */` is the inventory; a count in prose goes
stale on the next addition. Edit SKILL.md files here; do not edit the copies
under the repo-root `.claude/skills/` path — that whole directory is gitignored
(0 tracked files), so edits there are machine-local and never ship.

Seeder is idempotent: a SKILL.md change bumps `content_hash`, which triggers an
UPDATE with `version` incremented on next boot.
