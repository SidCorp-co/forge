-- ISS-1324. A warm android box was handed out as `agent` in 0.6 s on sid-xeon-1 while no emulator
-- listened on its serial, so the agent's first act failed DEVICE_NOT_FOUND and nothing said the
-- emulator had died. The runner now checks a warm box's screen answers before its hand-out and on
-- its heartbeat sweep, and fails one that does not `BOX_DEVICE_GONE`, with the check's answer.
--
-- ROLLBACK: ALTER TABLE "boxes" DROP CONSTRAINT IF EXISTS "boxes_failure_chk";
--   ALTER TABLE "boxes" ADD CONSTRAINT "boxes_failure_chk" CHECK ("failure" IS NULL OR "failure"
--   IN ('START_FAILED', 'STREAM_LOST', 'BOX_GONE', 'DEVICE_OFFLINE'));  (fails while a row holds
--   BOX_DEVICE_GONE)

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "boxes" DROP CONSTRAINT IF EXISTS "boxes_failure_chk";--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_failure_chk"
  CHECK ("failure" IS NULL OR "failure" IN ('START_FAILED', 'STREAM_LOST', 'BOX_GONE', 'DEVICE_OFFLINE', 'BOX_DEVICE_GONE'));
