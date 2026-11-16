-- ISS-1256 (owner 2026-11-16): the module map. A record belongs to one business module as a FIELD an
-- agent writes, never inferred, and terms and rules are linked by four stored relation kinds.
--   1. module_id on knowledge_entries, requirements, lessons, reference_sources and comments (a
--      decision's only), each a module label of the same project (checked by the placement door);
--      ON DELETE SET NULL, so a module removed leaves its records unplaced, shown as a gap.
--   2. knowledge_entries.term: a glossary entry's aliases (vi, code, industry) and who named it.
--   3. knowledge_relations, a new table: used_in, governs, from, anchored_at, each from a term or rule.
-- NULL on every row standing today and no row of any existing table is changed: nothing is placed by
-- this file, every placement is an agent's or a person's call after deploy.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS knowledge_relations;
--   ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_module_chk;
--   ALTER TABLE reference_sources DROP CONSTRAINT IF EXISTS reference_sources_module_chk;
--   ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_term_chk;
--   ALTER TABLE knowledge_entries DROP COLUMN term;
--   ALTER TABLE knowledge_entries, requirements, lessons, reference_sources, comments: DROP COLUMN module_id;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "module_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "term" jsonb;--> statement-breakpoint
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "module_id" uuid;--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "module_id" uuid;--> statement-breakpoint
ALTER TABLE "reference_sources" ADD COLUMN IF NOT EXISTS "module_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "module_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_entries_module_id_labels_id_fk') THEN
    ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_module_id_labels_id_fk"
      FOREIGN KEY ("module_id") REFERENCES "public"."labels"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirements_module_id_labels_id_fk') THEN
    ALTER TABLE "requirements" ADD CONSTRAINT "requirements_module_id_labels_id_fk"
      FOREIGN KEY ("module_id") REFERENCES "public"."labels"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lessons_module_id_labels_id_fk') THEN
    ALTER TABLE "lessons" ADD CONSTRAINT "lessons_module_id_labels_id_fk"
      FOREIGN KEY ("module_id") REFERENCES "public"."labels"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_sources_module_id_labels_id_fk') THEN
    ALTER TABLE "reference_sources" ADD CONSTRAINT "reference_sources_module_id_labels_id_fk"
      FOREIGN KEY ("module_id") REFERENCES "public"."labels"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_module_id_labels_id_fk') THEN
    ALTER TABLE "comments" ADD CONSTRAINT "comments_module_id_labels_id_fk"
      FOREIGN KEY ("module_id") REFERENCES "public"."labels"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "knowledge_entries" DROP CONSTRAINT IF EXISTS "knowledge_entries_term_chk";--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_term_chk" CHECK ("knowledge_entries"."term" IS NULL OR ("knowledge_entries"."kind" = 'glossary' AND jsonb_typeof("knowledge_entries"."term") = 'object'));--> statement-breakpoint
ALTER TABLE "reference_sources" DROP CONSTRAINT IF EXISTS "reference_sources_module_chk";--> statement-breakpoint
ALTER TABLE "reference_sources" ADD CONSTRAINT "reference_sources_module_chk" CHECK ("reference_sources"."module_id" IS NULL OR "reference_sources"."project_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "comments" DROP CONSTRAINT IF EXISTS "comments_module_chk";--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_module_chk" CHECK ("comments"."module_id" IS NULL OR "comments"."intent" = 'decision');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entries_module_idx" ON "knowledge_entries" USING btree ("project_id", "module_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requirements_module_idx" ON "requirements" USING btree ("module_id") WHERE "module_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lessons_module_idx" ON "lessons" USING btree ("module_id") WHERE "module_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reference_sources_module_idx" ON "reference_sources" USING btree ("module_id") WHERE "module_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_module_idx" ON "comments" USING btree ("module_id") WHERE "module_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_relations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "from_entry_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "to_type" text NOT NULL,
  "to_ref" text NOT NULL,
  "written_by" uuid,
  "written_agency" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "knowledge_relations_kind_chk" CHECK ("knowledge_relations"."kind" IN ('used_in', 'governs', 'from', 'anchored_at')),
  CONSTRAINT "knowledge_relations_to_type_chk" CHECK ("knowledge_relations"."to_type" IN ('term', 'rule', 'capability', 'requirement', 'decision', 'code')),
  CONSTRAINT "knowledge_relations_agency_chk" CHECK ("knowledge_relations"."written_agency" IN ('human', 'agent')),
  CONSTRAINT "knowledge_relations_to_ref_chk" CHECK (length("knowledge_relations"."to_ref") BETWEEN 1 AND 512)
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_relations_project_id_projects_id_fk') THEN
    ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_relations_from_entry_id_knowledge_entries_id_fk') THEN
    ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_from_entry_id_knowledge_entries_id_fk"
      FOREIGN KEY ("from_entry_id") REFERENCES "public"."knowledge_entries"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_relations_written_by_users_id_fk') THEN
    ALTER TABLE "knowledge_relations" ADD CONSTRAINT "knowledge_relations_written_by_users_id_fk"
      FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_relations_edge_uq" ON "knowledge_relations" USING btree ("from_entry_id", "kind", "to_type", "to_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_relations_project_idx" ON "knowledge_relations" USING btree ("project_id", "to_type", "to_ref");
