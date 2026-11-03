-- A beta pair records when its close was tried with beta's merge mark in the beta project's landing
-- shape (ISS-923 fix forward): the first mirror sent every mark as `landing`, which beta refuses
-- LANDING_NOT_THIS_SHAPE on a project that lands in git, so sid-desk ISS-769 and ISS-770 stopped at
-- awaiting_release. `close_shape_tried_at` is null on every row written before this migration, which
-- is how a fire knows a pair held by that old mark owes one more try under the shape. No existing row
-- is rewritten.
--
-- ROLLBACK: ALTER TABLE "beta_port_pairs" DROP COLUMN IF EXISTS "close_shape_tried_at"; a pair whose
-- close beta has not taken is then tried once more, and one beta closed is left.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "close_shape_tried_at" timestamp with time zone;
