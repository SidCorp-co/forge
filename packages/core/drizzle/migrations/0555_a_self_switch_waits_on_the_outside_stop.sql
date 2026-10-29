-- ISS-775 (REQ-77 BC-16). Four added columns on support_channel_switches, none rewriting a row, so
-- nothing is lost:
--   outside_is_self      the outside bot answers as the binding's own chat account, so the switch
--                        removes nobody from the group (false for every switch planned before);
--   outside_stopped_*    an operator's record that the outside bot's own process is stopped, which a
--                        self switch waits on in place of the removal.
--
-- ROLLBACK (only while nothing reads the columns):
--   ALTER TABLE support_channel_switches DROP COLUMN outside_is_self, DROP COLUMN outside_stopped_at,
--     DROP COLUMN outside_stopped_by, DROP COLUMN outside_stopped_note;
ALTER TABLE "support_channel_switches" ADD COLUMN IF NOT EXISTS "outside_is_self" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "support_channel_switches" ADD COLUMN IF NOT EXISTS "outside_stopped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "support_channel_switches" ADD COLUMN IF NOT EXISTS "outside_stopped_by" uuid;
--> statement-breakpoint
ALTER TABLE "support_channel_switches" ADD COLUMN IF NOT EXISTS "outside_stopped_note" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "support_channel_switches" ADD CONSTRAINT "support_channel_switches_outside_stopped_by_users_id_fk" FOREIGN KEY ("outside_stopped_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
