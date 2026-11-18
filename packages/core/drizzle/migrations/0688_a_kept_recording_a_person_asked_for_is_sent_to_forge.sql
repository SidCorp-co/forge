-- ISS-1338 (FB-747). A box's whole-session recording a person asked for stayed on its device once
-- the box closed: only a span's clip reached Forge, so a closed box whose recording was kept read
-- "No clip". Once a box ends, a recording a person or the open asked for is sent to Forge as an
-- attachment of the box's issue, and the box says where it is or why it could not come.
-- `recording_asked`: a person or the open asked for the recording, so only that one is sent; a
-- span's own recording never is. Every box before this asked for none that was sent, so false.
-- `session_*`: the sent recording, its clip and opening still, or its fault in words.
--
-- ROLLBACK: ALTER TABLE "boxes" DROP CONSTRAINT IF EXISTS "boxes_session_chk";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "session_detail";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "session_fault";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "session_still_id";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "session_clip_id";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "session_at";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "session_state";
--   ALTER TABLE "boxes" DROP COLUMN IF EXISTS "recording_asked";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "recording_asked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "session_state" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "session_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "session_clip_id" uuid REFERENCES "issue_attachments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "session_still_id" uuid REFERENCES "issue_attachments"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "session_fault" text;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN IF NOT EXISTS "session_detail" text;--> statement-breakpoint
ALTER TABLE "boxes" DROP CONSTRAINT IF EXISTS "boxes_session_chk";--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_session_chk"
  CHECK (("session_state" IS NULL OR "session_state" IN ('sending', 'attached', 'failed'))
    AND ("session_state" IS NULL) = ("session_at" IS NULL)
    AND ("session_state" IS NOT DISTINCT FROM 'failed') = ("session_fault" IS NOT NULL)
    AND ("session_fault" IS NULL OR "session_fault" IN ('TOO_LARGE', 'DEVICE_GONE', 'NO_ANSWER', 'CUT_FAILED', 'SEND_FAILED', 'NO_ISSUE')));
