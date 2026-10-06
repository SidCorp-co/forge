-- A release number is spent when it leaves Forge, not when a batch is opened (ISS-234: dev.35 and
-- dev.36 were cut by batches that aborted before any push, and exist nowhere outside this table).
--
-- The unique index narrows from every row carrying a version to the rows still holding one: a run
-- that shipped, or one not yet ended. An ended, unshipped run keeps `release_version` as the number
-- it tried, and the next batch may wear that number again when nothing left Forge under it; the
-- allocator (`highestSpentVersion`) also counts an ended run that recorded a promotion, a finish or
-- a pushed tag as spent, which this predicate cannot read, so the index stays the backstop and the
-- allocator the rule. The new predicate is narrower than the old, so no existing row can violate it.
--
-- ROLLBACK: DROP INDEX "pipeline_runs_release_version_uq"; then recreate it WHERE release_version IS
-- NOT NULL, which refuses if two rows already wear one number.

DROP INDEX IF EXISTS "pipeline_runs_release_version_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_release_version_uq" ON "pipeline_runs" USING btree ("project_id","release_version") WHERE release_version IS NOT NULL AND (release_released_at IS NOT NULL OR status NOT IN ('cancelled', 'failed'));
