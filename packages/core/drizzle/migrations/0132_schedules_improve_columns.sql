-- ISS-545 — improvement-message subscription columns on schedules (foundation for skill-improve).
-- All additive + nullable; existing rows read NULL (= plain schedule, not an improvement subscription).
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "template_key" text;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "params" jsonb;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "mode" text;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "applied_message_versions" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_template_key_idx" ON "schedules" ("project_id", "template_key") WHERE "template_key" IS NOT NULL;
