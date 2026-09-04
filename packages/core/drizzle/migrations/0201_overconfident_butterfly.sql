-- How many pipeline jobs one BOX may carry at once, across every project it
-- serves. Default 1 preserves today's behaviour exactly: nothing changes until
-- an operator raises it on a specific device.
--
-- The CHECK is not decoration. This column is read into a dispatch gate, and a
-- 0 there is not "unlimited" — it is a box that silently stops taking work,
-- which reads to an operator as a dead runner. A negative or absurd value is a
-- typo that would either wedge the device or oversubscribe the machine into
-- swap. Refuse the write where the typo happens rather than debugging its
-- effect three gates downstream.
ALTER TABLE "devices" ADD COLUMN "max_concurrent" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_max_concurrent_sane"
  CHECK ("max_concurrent" >= 1 AND "max_concurrent" <= 16);
