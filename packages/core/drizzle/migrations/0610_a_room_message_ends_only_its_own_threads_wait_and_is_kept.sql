-- ISS-1038 — a confirm wait on a room message was ended by any member message in any support room of
-- the project, and the item kept only the time. A wait now names the chat group and thread whose next
-- member message ends it: the ones its setter named, else the thread the item was recorded from
-- (`support_feedback_links`). The message that ends it is kept on the item: its id, group, thread,
-- author, time and words.
--
-- A room-message wait standing now takes the thread its item was recorded from. One whose item no
-- room recorded keeps none, and only its date ends it; the item's read says so (`room` null).
--
-- ROLLBACK:
--   ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_confirm_wait_room_chk";
--   ALTER TABLE "feedback" DROP COLUMN IF EXISTS "confirm_wait_met_by";
--   ALTER TABLE "feedback" DROP COLUMN IF EXISTS "confirm_wait_thread";
--   ALTER TABLE "feedback" DROP COLUMN IF EXISTS "confirm_wait_rid";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_rid" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_thread" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "confirm_wait_met_by" jsonb;--> statement-breakpoint
UPDATE "feedback" f
   SET "confirm_wait_rid" = r."rid", "confirm_wait_thread" = l."thread"
  FROM "support_feedback_links" l
  JOIN "support_rooms" r ON r."id" = l."room_id"
 WHERE l."feedback_id" = f."id"
   AND f."confirm_wait_on" = 'room_message'
   AND f."confirm_wait_rid" IS NULL;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_confirm_wait_room_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_confirm_wait_room_chk" CHECK (("confirm_wait_rid" IS NULL) = ("confirm_wait_thread" IS NULL) AND ("confirm_wait_rid" IS NULL OR "confirm_wait_on" = 'room_message') AND ("confirm_wait_met_by" IS NULL OR "confirm_wait_met_at" IS NOT NULL));
