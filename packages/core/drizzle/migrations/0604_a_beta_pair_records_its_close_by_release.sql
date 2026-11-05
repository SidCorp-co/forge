-- A beta pair's close is tried at every fire until beta stands closed (ISS-1005): a dev release
-- closed sidpeak's twins, and beta closes an issue only by a release of its own, so the mirror now
-- records that dev release on beta (`POST /api/projects/:id/release-records`). `close_refused` names
-- the refusal such a close met and commented on the beta issue, so the comment is made once while
-- the close keeps being tried. `close_shape_tried_at` (ISS-923 fix forward) said whether a close owed
-- one more try under the beta project's landing shape; every unclosed close is now owed until beta
-- closes it, so nothing reads it, and it is dropped. No existing row is rewritten.
--
-- ROLLBACK: ALTER TABLE "beta_port_pairs" DROP COLUMN IF EXISTS "close_refused", ADD COLUMN IF NOT
-- EXISTS "close_shape_tried_at" timestamp with time zone; every pair then reads as tried before the
-- landing shape and its close is tried once more, which beta answers as it would any close.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "close_refused" text;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" DROP COLUMN IF EXISTS "close_shape_tried_at";
