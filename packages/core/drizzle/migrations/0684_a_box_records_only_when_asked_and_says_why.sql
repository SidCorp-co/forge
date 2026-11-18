-- ISS-1321. Every Forge Box recorded its whole session from start to close (a browser box wrote
-- 21 MB in 8 minutes on sid-xeon-1), though the only reader is a criterion's span clip. The owner
-- ruled recording optional (2026-11-18): nothing records by default and a warm box never does.
-- `recording_why` says who wants a box recording now: `asked` (an open naming `record`, or an
-- agent), `span` (a criterion's span began it, and the last open span's end stops it), `person`
-- (the Boxes page's toggle); null when nobody does. Rows recorded before this keep a null why: no
-- one asked, the runner recorded every box, and the record says no more than that.
--
-- ROLLBACK: ALTER TABLE "boxes" DROP COLUMN IF EXISTS "recording_why";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "recording_why" text;--> statement-breakpoint
ALTER TABLE "boxes" DROP CONSTRAINT IF EXISTS "boxes_recording_why_chk";--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_recording_why_chk"
  CHECK ("recording_why" IS NULL OR "recording_why" IN ('asked', 'span', 'person'));
