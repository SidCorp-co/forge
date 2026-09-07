-- ISS-947 — the module registry's slug and its 1:1 knowledge-node binding, additive in every
-- statement.
--
-- `labels.slug` is a module's identity: derived from the name once and never recomputed, so a
-- rename cannot orphan the node. `labels.knowledge_entry_id` is that node, or NULL — a module may
-- exist before anyone writes its node, and `ON DELETE SET NULL` is what makes deleting the node
-- clear the link rather than delete the module.
--
-- Classification: ADDITIVE. Every existing `labels` row keeps its columns; plain labels read back
-- with a NULL slug and a NULL node, which is exactly what `labels_slug_chk` and
-- `labels_knowledge_entry_chk` require of them, so no existing row has to change to satisfy the
-- new constraints. Running it backwards drops two columns no code before this change reads.
--
-- The one statement that could fail on live data is the slug backfill, and it cannot: the
-- `row_number()` clause below assigns within `(project_id, base_slug)` in a total order
-- (`created_at`, then `id`), so two modules whose distinct names derive one base — "API/v2" and
-- "API v2" — get `api-v2` and `api-v2-2` rather than a unique violation. That suffix rule is the
-- same one `labels/module-service.ts#deriveModuleSlug` applies at runtime; the two are a declared
-- lockstep pair, because a module created before this migration and one created after must answer
-- to the same slug for the same name.
ALTER TABLE "labels" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "knowledge_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_knowledge_entry_id_knowledge_entries_id_fk" FOREIGN KEY ("knowledge_entry_id") REFERENCES "public"."knowledge_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "labels" AS l
SET "slug" = d."slug"
FROM (
  SELECT
    "id",
    CASE WHEN "rn" = 1 THEN "base" ELSE "base" || '-' || "rn" END AS "slug"
  FROM (
    SELECT
      "id",
      "base",
      row_number() OVER (PARTITION BY "project_id", "base" ORDER BY "created_at", "id") AS "rn"
    FROM (
      SELECT
        "id",
        "project_id",
        "created_at",
        COALESCE(
          NULLIF(TRIM(BOTH '-' FROM regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')), ''),
          'module'
        ) AS "base"
      FROM "labels"
      WHERE "kind" = 'module'
    ) AS "based"
  ) AS "numbered"
) AS d
WHERE l."id" = d."id";--> statement-breakpoint
CREATE UNIQUE INDEX "labels_project_id_slug_uq" ON "labels" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "labels_knowledge_entry_id_uq" ON "labels" USING btree ("knowledge_entry_id");--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_slug_chk" CHECK (("labels"."kind" = 'module') = ("labels"."slug" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_knowledge_entry_chk" CHECK ("labels"."kind" = 'module' OR "labels"."knowledge_entry_id" IS NULL);
