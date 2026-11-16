-- ISS-1252 (criterion 2, reopened). A followed release is matched to an open item by the fast
-- model's judgement of the nearest open items, no longer by the word stems both hold, so a release's
-- row keeps the model's one line instead of the stems:
--   1. reference_releases.why, a new text column: on an idea, how the release helps the item; on a
--      silent row, why it was not judged (no vector or no model), null where it was judged no match.
--   2. Each row matched by words keeps its stems as its why, "Both name: <stems>", the line its idea
--      said; then reference_releases.matched_terms is dropped.
-- No other row or table changes; the outcome check (`idea` iff matched_ref) is untouched.
--
-- ROLLBACK:
--   ALTER TABLE reference_releases ADD COLUMN IF NOT EXISTS matched_terms text[];
--   ALTER TABLE reference_releases DROP COLUMN IF EXISTS why;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "reference_releases" ADD COLUMN IF NOT EXISTS "why" text;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reference_releases' AND column_name = 'matched_terms'
  ) THEN
    UPDATE "reference_releases"
       SET "why" = 'Both name: ' || array_to_string("matched_terms", ', ')
     WHERE "why" IS NULL AND "matched_terms" IS NOT NULL AND cardinality("matched_terms") > 0;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "reference_releases" DROP COLUMN IF EXISTS "matched_terms";
