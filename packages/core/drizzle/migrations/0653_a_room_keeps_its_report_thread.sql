-- ISS-1224 (owner ruling 2026-11-12, repeating 2026-10-31 and 2026-11-01): a bot never posts a report
-- at a work room's top level. A support room keeps its report thread, where a master's post naming no
-- thread and core's room-down line land instead:
--   1. support_rooms.report_thread: the thread's first message id; null on every row today.
--   2. support_rooms.report_thread_by: `person` where a person named a thread they wrote in, `forge`
--      where Forge opened its own with one anchor line; null with no thread, as the CHECK holds.
-- Both are null on every row standing today, so no row is changed and every CHECK holds.
--
-- ROLLBACK:
--   ALTER TABLE support_rooms DROP CONSTRAINT support_rooms_report_thread_chk;
--   ALTER TABLE support_rooms DROP COLUMN report_thread_by;
--   ALTER TABLE support_rooms DROP COLUMN report_thread;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_rooms" ADD COLUMN IF NOT EXISTS "report_thread" text;--> statement-breakpoint
ALTER TABLE "support_rooms" ADD COLUMN IF NOT EXISTS "report_thread_by" text;--> statement-breakpoint
ALTER TABLE "support_rooms" DROP CONSTRAINT IF EXISTS "support_rooms_report_thread_chk";--> statement-breakpoint
ALTER TABLE "support_rooms" ADD CONSTRAINT "support_rooms_report_thread_chk" CHECK (("support_rooms"."report_thread" IS NULL) = ("support_rooms"."report_thread_by" IS NULL) AND ("support_rooms"."report_thread_by" IS NULL OR "support_rooms"."report_thread_by" IN ('person', 'forge')));
