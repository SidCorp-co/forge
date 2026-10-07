-- A release's approver could not tell what kind of change it carried: a landing was free text, and a
-- design revision that deploys nothing read like code. merged_artifacts holds what the landing
-- changed, one {surface, ref, change} per artifact, written beside merged_landing by the mark and by
-- a design approval. NULL is a landing naming nothing structured, which every row written before this
-- is: no backfill, those read as unclassified until their issue releases.
--
-- ROLLBACK: ALTER TABLE issues DROP CONSTRAINT issues_merged_artifacts_chk, DROP COLUMN merged_artifacts.

ALTER TABLE "issues" ADD COLUMN "merged_artifacts" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_artifacts_chk" CHECK ("issues"."merged_artifacts" IS NULL OR ("issues"."merged_at" IS NOT NULL AND jsonb_typeof("issues"."merged_artifacts") = 'array' AND jsonb_array_length("issues"."merged_artifacts") > 0));
