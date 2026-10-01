ALTER TABLE "issues" ADD COLUMN "merged_target" text;--> statement-breakpoint
CREATE INDEX "job_events_secret_resolve_idx" ON "job_events" USING btree ("job_id") WHERE kind = 'secret_resolve';