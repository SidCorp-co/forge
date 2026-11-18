-- ISS-1322. An agent on a box's device may attach its own tools (Playwright, chrome-devtools-mcp) to a
-- browser box's CDP, through the device's proxy, where the person's hold still binds. The device
-- reports where that proxy answers (`attach`, a loopback URL handed only to an agent on that device)
-- and what attached sessions did, which core writes into the act feed. `box_acts.via` says how an act
-- reached the box: `act` through the act door, `input` a person's input socket, `cdp` an attached
-- session. Every act before this came through the act door or a person's input socket.
--
-- ROLLBACK: ALTER TABLE "box_acts" DROP CONSTRAINT IF EXISTS "box_acts_via_chk";
--   ALTER TABLE "box_acts" DROP COLUMN IF EXISTS "via";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "attach";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "attach" jsonb;--> statement-breakpoint
ALTER TABLE "box_acts" ADD COLUMN IF NOT EXISTS "via" text;--> statement-breakpoint
UPDATE "box_acts" SET "via" = CASE WHEN "by" = 'person' THEN 'input' ELSE 'act' END WHERE "via" IS NULL;--> statement-breakpoint
ALTER TABLE "box_acts" ALTER COLUMN "via" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "box_acts" DROP CONSTRAINT IF EXISTS "box_acts_via_chk";--> statement-breakpoint
ALTER TABLE "box_acts" ADD CONSTRAINT "box_acts_via_chk" CHECK ("via" IN ('act', 'input', 'cdp'));
