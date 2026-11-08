-- ISS-685 r2. A device that reported a runner at or past the git relay (0.18.0) is latched: the
-- credential door never hands it a relayed host's connection token again, whatever version it
-- reports after. The version a box reports is its own word, and a heartbeat back to 0.17.0 handed
-- the token over in two requests. Devices already reporting such a version are latched now, so
-- nothing they are served changes.
--
-- ROLLBACK: ALTER TABLE "devices" DROP COLUMN "relay_runner_at";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "relay_runner_at" timestamp with time zone;--> statement-breakpoint
UPDATE "devices" SET "relay_runner_at" = now()
 WHERE "relay_runner_at" IS NULL
   AND "agent_version" ~ '^\d+\.\d+\.\d+$'
   AND string_to_array("agent_version", '.')::int[] >= ARRAY[0, 18, 0];
