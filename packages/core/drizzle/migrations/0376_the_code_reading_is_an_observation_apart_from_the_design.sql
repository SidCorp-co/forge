CREATE TABLE "project_workflow_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"at_sha" text NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"source" text NOT NULL,
	"written_by" uuid NOT NULL,
	"written_by_agency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workflow_observations_sha_chk" CHECK ("project_workflow_observations"."at_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "project_workflow_observations_revision_chk" CHECK ("project_workflow_observations"."revision" >= 1),
	CONSTRAINT "project_workflow_observations_source_chk" CHECK ("project_workflow_observations"."source" IN ('observer', 'migrated')),
	CONSTRAINT "project_workflow_observations_agency_chk" CHECK ("project_workflow_observations"."written_by_agency" IN ('human', 'agent'))
);
--> statement-breakpoint
ALTER TABLE "project_workflows" DROP CONSTRAINT "project_workflows_status_chk";--> statement-breakpoint
ALTER TABLE "project_workflows" DROP CONSTRAINT "project_workflows_sha_chk";--> statement-breakpoint
ALTER TABLE "project_workflow_observations" ADD CONSTRAINT "project_workflow_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workflow_observations" ADD CONSTRAINT "project_workflow_observations_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workflow_observations" ADD CONSTRAINT "project_workflow_observations_written_by_users_id_fk" FOREIGN KEY ("written_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_workflow_observations_sha_uq" ON "project_workflow_observations" USING btree ("workflow_id","at_sha");--> statement-breakpoint
CREATE INDEX "project_workflow_observations_project_idx" ON "project_workflow_observations" USING btree ("project_id","workflow_id","created_at");--> statement-breakpoint
INSERT INTO "project_workflow_observations" ("project_id", "workflow_id", "at_sha", "revision", "document", "source", "written_by", "written_by_agency")
SELECT w."project_id", w."id", w."document"->>'refreshedAtSha', w."revision",
  jsonb_build_object(
    'summary', 'Moved from the design document by migration 0375: the code reading it held at ' || left(w."document"->>'refreshedAtSha', 9) || '.',
    'steps', (
      SELECT coalesce(jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'id', t.s->>'id', 'title', t.s->'title', 'does', t.s->'does', 'after', t.s->'after',
          'node', t.s->'node', 'evidence', (t.s->'evidence') - 'annotation'
        )) || jsonb_build_object('matches', t.s->>'id')
        ORDER BY t.ord), '[]'::jsonb)
      FROM jsonb_array_elements(w."document"->'steps') WITH ORDINALITY AS t(s, ord)
      WHERE jsonb_typeof(t.s->'evidence') = 'object'
    ),
    'edges', '[]'::jsonb,
    'drift', CASE WHEN jsonb_typeof(w."document"->'drift') = 'object'
      THEN jsonb_build_object('steps', w."document"->'drift'->'steps', 'reason', w."document"->'drift'->>'reason')
      ELSE 'null'::jsonb END
  ),
  'migrated', w."written_by_user", CASE WHEN u."kind" = 'agent' THEN 'agent' ELSE 'human' END
FROM "project_workflows" w
JOIN "users" u ON u."id" = w."written_by_user"
WHERE w."document"->>'version' = '2'
  AND w."document"->>'refreshedAtSha' ~ '^[0-9a-f]{40}$'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(w."document"->'steps') AS e(s) WHERE jsonb_typeof(e.s->'evidence') = 'object');--> statement-breakpoint
UPDATE "project_workflows" SET "document" = ("document" - 'drift' - 'refreshedAtSha' - 'status')
  || jsonb_build_object('steps', (
    SELECT coalesce(jsonb_agg((t.s - 'status' - 'evidence') ORDER BY t.ord), '[]'::jsonb)
    FROM jsonb_array_elements("document"->'steps') WITH ORDINALITY AS t(s, ord)))
WHERE "document"->>'version' = '2';--> statement-breakpoint
UPDATE "project_workflow_designs" SET "document" = ("document" - 'drift' - 'refreshedAtSha' - 'status')
  || jsonb_build_object('steps', (
    SELECT coalesce(jsonb_agg((t.s - 'status' - 'evidence') ORDER BY t.ord), '[]'::jsonb)
    FROM jsonb_array_elements("document"->'steps') WITH ORDINALITY AS t(s, ord)))
WHERE "document"->>'version' = '2';--> statement-breakpoint
ALTER TABLE "project_workflows" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "project_workflows" DROP COLUMN "refreshed_at_sha";