-- ISS-1252 (owner 2026-11-16). A project names the sources it learns from first: repos, products,
-- projects, patterns and docs, each with why, the areas it informs, a priority and whether its
-- releases are followed; an org entry (project_id null) is shared by every project of the org.
--   1. reference_sources, a new table: one row per source, removed by `removed_at` and kept.
--   2. reference_releases, a new table: a followed source's release as one project read it, an idea
--      filed on the open item it may help or silent on the timeline; one row per source, project, tag.
--   3. reference_citations, a new table, insert-only: an agent's or a person's use of a source.
-- No row of any existing table is changed. The forge seed list goes through the add door after
-- deploy, never through this file.
--
-- ROLLBACK (no other table references these):
--   DROP TABLE IF EXISTS reference_citations;
--   DROP TABLE IF EXISTS reference_releases;
--   DROP TABLE IF EXISTS reference_sources;
--   DROP FUNCTION IF EXISTS reference_citations_insert_only();

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reference_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "project_id" uuid,
  "kind" text NOT NULL,
  "url" text NOT NULL,
  "title" text NOT NULL,
  "why" text NOT NULL,
  "areas" text[] NOT NULL,
  "priority" integer NOT NULL,
  "follow_releases" boolean DEFAULT false NOT NULL,
  "origin" text NOT NULL,
  "evidence" text,
  "added_by" uuid NOT NULL,
  "added_agency" text NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  "removed_by" uuid,
  "removed_reason" text,
  "last_seen_tag" text,
  "last_release_at" timestamp with time zone,
  "last_checked_at" timestamp with time zone,
  "follow_etag" text,
  "follow_error" text,
  "repo_archived" boolean,
  "repo_pushed_at" timestamp with time zone,
  CONSTRAINT "reference_sources_kind_chk" CHECK ("reference_sources"."kind" IN ('repo', 'product', 'project', 'pattern', 'doc')),
  CONSTRAINT "reference_sources_origin_chk" CHECK ("reference_sources"."origin" IN ('added', 'proposed') AND (("reference_sources"."origin" = 'proposed') = ("reference_sources"."evidence" IS NOT NULL))),
  CONSTRAINT "reference_sources_agency_chk" CHECK ("reference_sources"."added_agency" IN ('human', 'agent')),
  CONSTRAINT "reference_sources_areas_chk" CHECK (cardinality("reference_sources"."areas") BETWEEN 1 AND 12),
  CONSTRAINT "reference_sources_removed_chk" CHECK (("reference_sources"."removed_at" IS NULL) = ("reference_sources"."removed_by" IS NULL) AND ("reference_sources"."removed_at" IS NULL) = ("reference_sources"."removed_reason" IS NULL))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_sources_org_id_organizations_id_fk') THEN
    ALTER TABLE "reference_sources" ADD CONSTRAINT "reference_sources_org_id_organizations_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_sources_project_id_projects_id_fk') THEN
    ALTER TABLE "reference_sources" ADD CONSTRAINT "reference_sources_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_sources_added_by_users_id_fk') THEN
    ALTER TABLE "reference_sources" ADD CONSTRAINT "reference_sources_added_by_users_id_fk"
      FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_sources_removed_by_users_id_fk') THEN
    ALTER TABLE "reference_sources" ADD CONSTRAINT "reference_sources_removed_by_users_id_fk"
      FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reference_sources_org_idx" ON "reference_sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reference_sources_project_idx" ON "reference_sources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reference_sources_active_url_uq" ON "reference_sources" USING btree ("org_id", COALESCE("project_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("url")) WHERE removed_at IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reference_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "tag" text NOT NULL,
  "name" text,
  "url" text NOT NULL,
  "published_at" timestamp with time zone,
  "outcome" text NOT NULL,
  "matched_ref" text,
  "matched_terms" text[],
  "feedback_id" uuid,
  "read_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reference_releases_outcome_chk" CHECK ("reference_releases"."outcome" IN ('idea', 'silent') AND (("reference_releases"."outcome" = 'idea') = ("reference_releases"."matched_ref" IS NOT NULL)))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_releases_project_id_projects_id_fk') THEN
    ALTER TABLE "reference_releases" ADD CONSTRAINT "reference_releases_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_releases_source_id_reference_sources_id_fk') THEN
    ALTER TABLE "reference_releases" ADD CONSTRAINT "reference_releases_source_id_reference_sources_id_fk"
      FOREIGN KEY ("source_id") REFERENCES "public"."reference_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_releases_feedback_id_feedback_id_fk') THEN
    ALTER TABLE "reference_releases" ADD CONSTRAINT "reference_releases_feedback_id_feedback_id_fk"
      FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reference_releases_project_idx" ON "reference_releases" USING btree ("project_id", "source_id", "read_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reference_releases_tag_uq" ON "reference_releases" USING btree ("source_id", "project_id", "tag");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reference_citations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "source_id" uuid NOT NULL,
  "ref" text NOT NULL,
  "verdict" text NOT NULL,
  "why" text NOT NULL,
  "about" text,
  "cited_by" uuid NOT NULL,
  "cited_agency" text NOT NULL,
  "cited_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reference_citations_verdict_chk" CHECK ("reference_citations"."verdict" IN ('take', 'reject')),
  CONSTRAINT "reference_citations_agency_chk" CHECK ("reference_citations"."cited_agency" IN ('human', 'agent'))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_citations_project_id_projects_id_fk') THEN
    ALTER TABLE "reference_citations" ADD CONSTRAINT "reference_citations_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_citations_source_id_reference_sources_id_fk') THEN
    ALTER TABLE "reference_citations" ADD CONSTRAINT "reference_citations_source_id_reference_sources_id_fk"
      FOREIGN KEY ("source_id") REFERENCES "public"."reference_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reference_citations_cited_by_users_id_fk') THEN
    ALTER TABLE "reference_citations" ADD CONSTRAINT "reference_citations_cited_by_users_id_fk"
      FOREIGN KEY ("cited_by") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reference_citations_project_idx" ON "reference_citations" USING btree ("project_id", "source_id", "cited_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION reference_citations_insert_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'REFERENCE_CITATION_INSERT_ONLY: citation % is a record of one use and is never changed', OLD.id;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS reference_citations_insert_only ON "reference_citations";--> statement-breakpoint
CREATE TRIGGER reference_citations_insert_only BEFORE UPDATE ON "reference_citations"
  FOR EACH ROW EXECUTE FUNCTION reference_citations_insert_only();
