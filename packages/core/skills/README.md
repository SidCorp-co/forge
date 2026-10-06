# Bundled forge-* skills

Source of truth for the built-in pipeline skills seeded into the `skills` table
on server start (see `src/skills/builtin-seed.ts`). The set is whatever
subdirectories exist here — `ls -d */` is the inventory; a count in prose goes
stale on the next addition. Edit SKILL.md files here, never a copy under the
repository root's .claude directory: `.gitignore` keeps all of it (`.claude/*`)
out of the tree, so an edit there is machine-local and never ships.

Seeder is idempotent: a SKILL.md change bumps `content_hash`, which triggers an
UPDATE with `version` incremented on next boot.
