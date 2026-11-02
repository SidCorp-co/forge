-- A chat room asks a parked run's question inside a thread, never at its top level (ISS-873): the
-- thread it was raised in, or else the room's one thread for the day's questions, which several
-- questions share. `rocketchat_daily_threads` remembers that thread per room and UTC day; a
-- question registered in it is `shared`, and only an unshared thread stays one question's alone,
-- so the anchor rule (one decision, one thread) still holds where a question takes an anchor.
--
-- ROLLBACK: drop `rocketchat_daily_threads`, delete the `shared` rows, drop the column and restore
-- the unique `rcq_threads_room_idx` over (connection_id, rid, tmid).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "rcq_threads_room_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "rcq_threads_room_idx" ON "rocketchat_question_threads" USING btree ("connection_id","rid","tmid") WHERE NOT "shared";--> statement-breakpoint
CREATE INDEX "rcq_threads_room_lookup_idx" ON "rocketchat_question_threads" USING btree ("connection_id","rid","tmid");--> statement-breakpoint
CREATE TABLE "rocketchat_daily_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "integration_connections"("id") ON DELETE cascade,
  "rid" text NOT NULL,
  "day" text NOT NULL,
  "tmid" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "rc_daily_threads_day_chk" CHECK ("day" ~ '^\d{4}-\d{2}-\d{2}$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "rc_daily_threads_room_day_idx" ON "rocketchat_daily_threads" USING btree ("connection_id","rid","day");
