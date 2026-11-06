-- ISS-1044 — a steward note records the steward's facts version it was written under
-- (`steward/facts-version.ts:stewardFactsVersion`), so a note written before core reworded the facts
-- it states reads stale and is re-diagnosed by the sweep, though the item's basis never moved.
--
-- Every note already written keeps NULL: it was written under facts no note recorded, so each reads
-- stale once this lands and the sweep rewrites it, within its share of the day, oldest note first.
-- Nothing is rewritten here: the table is insert-only (`steward_notes_guard_trg`), and a new column
-- added with no default changes no row.
--
-- ROLLBACK: ALTER TABLE "steward_notes" DROP COLUMN IF EXISTS "facts_version";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "steward_notes" ADD COLUMN IF NOT EXISTS "facts_version" text;
