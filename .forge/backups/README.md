# `.forge/backups/`

Snapshots of rows a migration deletes that **no other copy holds**. One file per
migration that needed one; nothing here is read by code.

A backup belongs here only when the deletion is irreversible in the sense the
migration-risk rule means: re-running the migration backwards restores the
schema and not the values. If git, a seeder or another table can reproduce the
rows, do not add a file — a second copy of a recoverable thing goes stale and
then misleads.

| File | Migration | What it holds |
|---|---|---|
| `iss895-staged-skills.json.gz` | `0209_drop_staged_lane` | 178 `skills` rows + 182 `skill_registrations`, taken from forge-beta 2026-09-05T12:15:35Z. The 9 global templates are also in git — find the deleting commit with `git log --diff-filter=D -- packages/core/skills/forge-plan` and read `<sha>^:packages/core/skills/`; the **169 per-project forks are not**, and all 169 differ from their template, so this file is their only copy. Restore one row with `jq '.skills[] \| select(.project_id == "…" and .name == "…")'`. |
