ALTER TABLE "jobs" ADD COLUMN "held_by" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "held_at" timestamp with time zone;