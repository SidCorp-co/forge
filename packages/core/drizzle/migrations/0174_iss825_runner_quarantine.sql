ALTER TABLE "runners" ADD COLUMN "quarantined_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "quarantine_reason" text;
