-- Undo 0262 (ISS-1016). Six indexes and one extension, none of which holds a
-- value: dropping them discards no row and no column, which is why 0262
-- classifies as additive rather than tightening or destructive.
--
-- What this does NOT undo: the application code that selects a list projection
-- and takes `matchedFields` from SQL keeps working against a database with
-- these indexes gone — it answers the same rows, slower. Reverting the code is
-- the merge revert and is independent of this file.
--
-- The extension is dropped last and only if nothing else came to depend on it;
-- `DROP EXTENSION` without CASCADE refuses rather than taking an index with it,
-- which is the refusal we want if a later migration built on pg_trgm.

DROP INDEX IF EXISTS "issues_project_updated_at_idx";
DROP INDEX IF EXISTS "issues_project_created_at_idx";
DROP INDEX IF EXISTS "issues_acceptance_criteria_trgm_idx";
DROP INDEX IF EXISTS "issues_plan_trgm_idx";
DROP INDEX IF EXISTS "issues_description_trgm_idx";
DROP INDEX IF EXISTS "issues_title_trgm_idx";
DROP EXTENSION IF EXISTS pg_trgm;
