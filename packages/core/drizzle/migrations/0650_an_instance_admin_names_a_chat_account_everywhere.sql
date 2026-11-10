-- ISS-1210 (FB-612). An instance admin names the Forge account a chat account is, once, and the naming
-- holds in every project: a project admin's naming (ISS-976) held in its own project alone, so the
-- owner whose chat server reports no address was refused again in each project nobody named him in.
--   1. speaker_link_namings.project_id may be NULL: a naming with no project is an instance admin's,
--      resolving in every project after that project's own naming. Every existing row keeps its
--      project, so every naming standing today resolves exactly as before; no row is changed.
--   2. One instance naming per speaker stands at a time, as one per speaker and project does.
--
-- ROLLBACK (only while no row has a NULL project_id):
--   DROP INDEX speaker_link_namings_instance_standing_uq;
--   ALTER TABLE speaker_link_namings ALTER COLUMN project_id SET NOT NULL;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "speaker_link_namings" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "speaker_link_namings_instance_standing_uq" ON "speaker_link_namings" USING btree ("source","external_namespace","external_id") WHERE project_id IS NULL AND undone_at IS NULL;
