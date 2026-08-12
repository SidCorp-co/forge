ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "notifications_dedupe_key_idx" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "activity_log_dedupe_key_idx" ON "activity_log" USING btree ("dedupe_key");
