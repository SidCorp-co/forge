ALTER TABLE "jobs" ADD COLUMN "kill_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "kill_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "kill_outcome" text;--> statement-breakpoint
CREATE INDEX "jobs_kill_requested_at_idx" ON "jobs" USING btree ("status","kill_requested_at") WHERE kill_requested_at IS NOT NULL;