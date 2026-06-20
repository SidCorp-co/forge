-- Accurate actor attribution on comments (ISS-519).
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0120, 0126).
--
-- comments.author_device_id — nullable FK to devices.id. The authoritative
--   "this comment was posted by an agent/device" marker. authorId always points
--   at the device's human owner (NOT-NULL FK to users), so it cannot distinguish
--   an agent comment from one the owner wrote; a non-null author_device_id can.
--   ON DELETE SET NULL: deleting a device de-marks its comments back to the
--   owner rather than blocking the delete. The human REST path leaves it null.
-- All additive + idempotent.

ALTER TABLE "comments" ADD COLUMN IF NOT EXISTS "author_device_id" uuid;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "comments" ADD CONSTRAINT "comments_author_device_id_devices_id_fk"
		FOREIGN KEY ("author_device_id") REFERENCES "devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
