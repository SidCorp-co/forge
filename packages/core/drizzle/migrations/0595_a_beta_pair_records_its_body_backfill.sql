-- The body a beta pair's dev issue was ported without (ISS-923 backfill): the first fire read issue
-- bodies from beta's list, which carries none, so its 25 dev issues hold only the provenance line. A
-- fire now writes beta's body under that line once per pair, and records it here: `body_backfilled_at`
-- when it was written (or beta's body was found empty), `body_backfill_fire_id` the fire that did it.
-- Both are null on every row written before this migration, which is how a fire knows a pair still
-- owes a look. No existing row is rewritten.
--
-- ROLLBACK: ALTER TABLE "beta_port_pairs" DROP CONSTRAINT IF EXISTS
-- "beta_port_pairs_body_backfill_fire_id_schedule_runs_id_fk", DROP COLUMN IF EXISTS
-- "body_backfill_fire_id", DROP COLUMN IF EXISTS "body_backfilled_at"; a dev issue still holding only
-- its provenance line is then backfilled again, and one already backfilled is no stub and is left.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "body_backfilled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD COLUMN IF NOT EXISTS "body_backfill_fire_id" uuid;--> statement-breakpoint
ALTER TABLE "beta_port_pairs" DROP CONSTRAINT IF EXISTS "beta_port_pairs_body_backfill_fire_id_schedule_runs_id_fk";--> statement-breakpoint
ALTER TABLE "beta_port_pairs" ADD CONSTRAINT "beta_port_pairs_body_backfill_fire_id_schedule_runs_id_fk" FOREIGN KEY ("body_backfill_fire_id") REFERENCES "public"."schedule_runs"("id") ON DELETE set null ON UPDATE no action;
