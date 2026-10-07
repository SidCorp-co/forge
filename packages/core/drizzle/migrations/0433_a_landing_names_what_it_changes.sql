-- A release's approver could not tell what kind of change it carried: a landing was free text, and a
-- design revision that deploys nothing read like code. merged_artifacts holds what the landing
-- changed, one {surface, ref, change} per artifact, written beside merged_landing by the mark and by
-- a design approval. NULL is a landing naming nothing structured, which every row written before this
-- is: no backfill, those read as unclassified until their issue releases. merged_paths holds the
-- paths a commit changed as the box read them from its own checkout, for a project whose source
-- host Forge cannot read; the release read classifies them by the project's surfaces map.
--
-- ROLLBACK: ALTER TABLE issues DROP CONSTRAINT issues_merged_artifacts_chk, DROP CONSTRAINT
-- issues_merged_paths_chk, DROP COLUMN merged_artifacts, DROP COLUMN merged_paths.

ALTER TABLE "issues" ADD COLUMN "merged_artifacts" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_artifacts_chk" CHECK ("issues"."merged_artifacts" IS NULL OR ("issues"."merged_at" IS NOT NULL AND jsonb_typeof("issues"."merged_artifacts") = 'array' AND jsonb_array_length("issues"."merged_artifacts") > 0));--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "merged_paths" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_paths_chk" CHECK ("issues"."merged_paths" IS NULL OR ("issues"."merged_at" IS NOT NULL AND jsonb_typeof("issues"."merged_paths") = 'object'));
