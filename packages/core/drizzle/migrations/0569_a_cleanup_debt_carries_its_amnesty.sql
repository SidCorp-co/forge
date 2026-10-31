-- A cleanup debt no change can clear is carried as a priced amnesty, recorded once on its row: what it
-- trades, what it costs and what ends it (REQ-79 r5 BC-10, ISS-842). A cleanup report was green or red
-- as its run judged, so debt 3d01ab3d read green on four fires and red on the fifth; a report's result
-- now follows from whether every debt it leaves is carried, and a carried one is read from here.
-- Every existing row starts uncarried.
--
-- ROLLBACK: drop the five columns and the check; carried debts read as ordinary open debt again.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "delivery_debts" ADD COLUMN IF NOT EXISTS "carried_trades" text;--> statement-breakpoint
ALTER TABLE "delivery_debts" ADD COLUMN IF NOT EXISTS "carried_costs" text;--> statement-breakpoint
ALTER TABLE "delivery_debts" ADD COLUMN IF NOT EXISTS "carried_ends_when" text;--> statement-breakpoint
ALTER TABLE "delivery_debts" ADD COLUMN IF NOT EXISTS "carried_by" uuid;--> statement-breakpoint
ALTER TABLE "delivery_debts" ADD COLUMN IF NOT EXISTS "carried_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_debts" DROP CONSTRAINT IF EXISTS "delivery_debts_carried_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "delivery_debts" ADD CONSTRAINT "delivery_debts_carried_by_users_id_fk" FOREIGN KEY ("carried_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_debts" DROP CONSTRAINT IF EXISTS "delivery_debts_carried_whole_chk";--> statement-breakpoint
ALTER TABLE "delivery_debts" ADD CONSTRAINT "delivery_debts_carried_whole_chk" CHECK (("delivery_debts"."carried_at" IS NULL AND "delivery_debts"."carried_trades" IS NULL AND "delivery_debts"."carried_costs" IS NULL AND "delivery_debts"."carried_ends_when" IS NULL) OR ("delivery_debts"."carried_at" IS NOT NULL AND "delivery_debts"."carried_trades" IS NOT NULL AND "delivery_debts"."carried_costs" IS NOT NULL AND "delivery_debts"."carried_ends_when" IS NOT NULL));
