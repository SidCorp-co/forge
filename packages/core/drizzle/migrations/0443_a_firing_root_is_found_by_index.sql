-- deliver.ts:inhibitor asks, for every condition a sweep sees again, whether a firing root cause of
-- the same project holds it back. The only index it could use was (project_id, created_at), so each
-- ask read every notification the project ever raised: on beta 9.0 M asks since 2026-09-18 at a
-- 1.7 ms mean, 15 329 s, the largest share of that database's statement time. Firing, unresolved
-- records are a handful, so a partial index over exactly them answers each ask from a few entries.
--
-- ROLLBACK: DROP INDEX IF EXISTS "notifications_firing_project_type_idx";

CREATE INDEX IF NOT EXISTS "notifications_firing_project_type_idx" ON "notifications" USING btree ("project_id", "type") WHERE "state" = 'firing' AND "resolved_at" IS NULL;
