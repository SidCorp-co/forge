-- ISS-992 — an issue reference names its project.
--
-- Both statements are ADDITIVE: a nullable column on `projects` and a new table. Every existing
-- row comes through untouched and code that has never heard of either keeps working, which is what
-- makes the way back a revert of the application and not of the schema.
--
-- `issue_prefix_aliases` is only ever inserted into. `project_id` goes NULL when its project is
-- deleted and the row STAYS, because freeing a dead project's prefix would let a second project
-- claim it and silently re-point every published `FD-977` at a different issue 977.
CREATE TABLE "issue_prefix_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"prefix" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_prefix_aliases_project_prefix_uq" UNIQUE("project_id","prefix")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "issue_prefix" text;--> statement-breakpoint
ALTER TABLE "issue_prefix_aliases" ADD CONSTRAINT "issue_prefix_aliases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_prefix_aliases_prefix_uq" ON "issue_prefix_aliases" USING btree ("prefix");--> statement-breakpoint
-- The pointer may only name a prefix this project already holds. MATCH SIMPLE skips the check
-- while `issue_prefix` is NULL, which is what leaves the legacy `ISS` default free.
ALTER TABLE "projects" ADD CONSTRAINT "projects_issue_prefix_fk" FOREIGN KEY ("id","issue_prefix") REFERENCES "public"."issue_prefix_aliases"("project_id","prefix") ON DELETE no action ON UPDATE no action;
