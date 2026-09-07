-- ISS-960: `filters.search` must reach `plan` and `acceptance_criteria`, so the identifier arm
-- that backs it (schema-types.ts:identifierTsQuery) has to be generated over those columns too —
-- otherwise `cascade` finds `runs-cascade.ts` in a title and silently not in a criterion.
-- `forge_identifier_words` is untouched: one immutable split function, four generated columns
-- (ISS-907). A generated column's expression cannot be altered in place, so the column is dropped
-- and re-added. Postgres drops "issues_ident_search_idx" with the column and drizzle-kit does NOT
-- re-emit it (its model still holds the index), so the CREATE below is hand-added and is the whole
-- reason this file is not the generated one. Rewrites `issues` once.
ALTER TABLE "issues" DROP COLUMN IF EXISTS "ident_search";--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "ident_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', forge_identifier_words(left("issues"."title" || ' ' || coalesce("issues"."description", '') || ' ' || coalesce("issues"."plan", '') || ' ' || coalesce("issues"."acceptance_criteria", ''), 100000)))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_ident_search_idx" ON "issues" USING gin ("ident_search");
