-- Skill Studio 2 (ISS-276) — project skill override = full-folder fork.
--
-- The markdown-only override (`skill_md_override` + `content_hash`) becomes a
-- fork of the whole global folder: it now also stores the editable copy of the
-- folder's files and snapshots the parent global's effective hash at fork time
-- so the effective view can flag "drift vs global vX" once the global moves.
--
--   * `files`               — SkillFile[] (path/content/encoding). Empty for
--                             legacy markdown-only rows; the resolver falls
--                             back to the base global files.
--   * `global_content_hash` — fork-time snapshot of the global's effective
--                             hash (`hashSkillBody(skillMd, files)`). NULL for
--                             legacy rows (no drift baseline until re-forked).
--
-- `content_hash` keeps its column but its meaning shifts to
-- `hashSkillBody(skillMdOverride, files)` (computed server-side on the next
-- PUT) so it matches the device-sync manifest's effectiveHash semantics.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0082_runners_repo_path / 0083_device_skills
-- headers). The runtime migrator applies this row from _journal.json.

ALTER TABLE "project_skill_overrides" ADD COLUMN IF NOT EXISTS "files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_skill_overrides" ADD COLUMN IF NOT EXISTS "global_content_hash" text;
