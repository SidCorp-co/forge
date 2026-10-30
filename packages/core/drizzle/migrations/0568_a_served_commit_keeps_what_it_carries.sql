-- Whether a served commit carries a commit a verdict was judged at, as the source host answered it,
-- kept per project. The weighing held that answer only in the process, so every deploy emptied it,
-- and a read, which asks the host nothing (ISS-774), read each runtime verdict a deploy ago as not
-- carried (forge-dev REQ-79, 2026-10-30). The pass that reads what a project serves now asks once
-- per new pair and writes the answer here; reads take it from here. Ancestry between two named
-- commits never changes, so a row is written once and never updated. No row exists before this.
--
-- ROLLBACK: drop the table; reads fall back to the release records and the process cache, and every
-- pair they do not answer reads unread until a release pass asks again.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "served_ancestry" (
	"project_id" uuid NOT NULL,
	"served_commit" text NOT NULL,
	"judged_commit" text NOT NULL,
	"carried" boolean NOT NULL,
	"differs_in" text[],
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "served_ancestry_project_id_served_commit_judged_commit_pk" PRIMARY KEY("project_id","served_commit","judged_commit"),
	CONSTRAINT "served_ancestry_whole_chk" CHECK ("served_ancestry"."served_commit" ~ '^[0-9a-f]{40}$' AND "served_ancestry"."judged_commit" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "served_ancestry_differs_chk" CHECK (("served_ancestry"."carried" AND "served_ancestry"."differs_in" IS NULL) OR (NOT "served_ancestry"."carried" AND "served_ancestry"."differs_in" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "served_ancestry" DROP CONSTRAINT IF EXISTS "served_ancestry_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "served_ancestry" ADD CONSTRAINT "served_ancestry_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
