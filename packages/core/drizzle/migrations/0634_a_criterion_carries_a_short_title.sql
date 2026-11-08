-- A criterion row shows a short title, with its full sentence on demand (ISS-1131, FB-567 point 3).
-- A requirement criterion and an issue criterion each gain an optional `title` of at most eight words;
-- the writes refuse a longer one by name (CRITERION_TITLE_TOO_LONG) before it reaches the row, and the
-- check holds the same rule for any writer. A criterion with none shows its first clause, cut at a
-- word boundary, on the screen.
--
-- ROLLBACK: ALTER TABLE "requirement_criteria" DROP COLUMN IF EXISTS "title"; ALTER TABLE "issue_criteria" DROP COLUMN IF EXISTS "title";
ALTER TABLE "requirement_criteria" ADD COLUMN IF NOT EXISTS "title" text;--> statement-breakpoint
ALTER TABLE "requirement_criteria" ADD CONSTRAINT "requirement_criteria_title_chk" CHECK ("title" IS NULL OR ("title" ~ '[^[:space:]]' AND "title" = btrim("title") AND array_length(regexp_split_to_array("title", '[[:space:]]+'), 1) <= 8));--> statement-breakpoint
ALTER TABLE "issue_criteria" ADD COLUMN IF NOT EXISTS "title" text;--> statement-breakpoint
ALTER TABLE "issue_criteria" ADD CONSTRAINT "issue_criteria_title_chk" CHECK ("title" IS NULL OR ("title" ~ '[^[:space:]]' AND "title" = btrim("title") AND array_length(regexp_split_to_array("title", '[[:space:]]+'), 1) <= 8));
