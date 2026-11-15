-- ISS-1245 (owner 2026-11-16): a box declares how many subagents it runs at once, beside its job-pane
-- ceiling, sized to the machine and never to AI quota. A live slot is an open run session, so no
-- table holds slots; this column is the one number `devices/run-slots.ts:slotsFor` shares among the
-- projects with work on the box.
--   devices.max_subagents: NULL until the box's runner declares it, 1-64 once it has.
-- NULL on every row standing today, so no row is changed and the CHECK holds.
--
-- ROLLBACK:
--   ALTER TABLE devices DROP CONSTRAINT devices_max_subagents_chk;
--   ALTER TABLE devices DROP COLUMN max_subagents;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "max_subagents" integer;--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_max_subagents_chk";--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_max_subagents_chk" CHECK ("devices"."max_subagents" IS NULL OR "devices"."max_subagents" BETWEEN 1 AND 64);
