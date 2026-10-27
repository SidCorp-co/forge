-- ISS-1421 r36 — judge-145: a cleared connection read back as "not one you can reach", and Mark a later
-- merge opened with Where it landed empty although the mark had named it. What a Clear deletes is
-- remembered by id, owner and the projects it was shared with, so a later read by one who could reach it
-- says it was cleared; and a git mark keeps where it said the work landed. Both start empty: no Clear
-- before this one left a record, and no mark kept its target.
CREATE TABLE "integration_connection_clears" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"project_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cleared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "merged_target" text;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_target_chk" CHECK ("issues"."merged_target" IS NULL OR ("issues"."merged_at" IS NOT NULL AND "issues"."merged_target" ~ '[^[:space:]]' AND char_length("issues"."merged_target") <= 200));