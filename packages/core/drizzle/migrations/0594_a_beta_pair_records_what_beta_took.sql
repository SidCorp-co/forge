-- What forge-beta actually took from a mirror (ISS-923 fix forward): `last_mirrored_status` was written
-- whether beta took the move or refused it, so a pair whose close beta refused (sid-desk ISS-769/770)
-- read as mirrored closed while beta stood elsewhere, and was never tried again. A try is now its own
-- record: `last_tried_status` is the dev status last tried (what keeps a move from repeating), and
-- `beta_reached` the beta status beta stood at after it, the move's target or the nearest legal one.
-- Both are null on every row written before this migration, which is how the next fire knows a pair
-- was tried under the old rule and tries it once more. No existing row is rewritten.
--
-- ROLLBACK: ALTER TABLE "beta_port_pairs" DROP COLUMN IF EXISTS "last_tried_status", DROP COLUMN IF
-- EXISTS "beta_reached"; a pair then reads as tried under the old rule again.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "last_tried_status" text;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "beta_reached" text;
