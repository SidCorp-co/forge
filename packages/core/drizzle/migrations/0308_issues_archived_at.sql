ALTER TABLE "issues" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "issues_archived_at_idx" ON "issues" USING btree ("archived_at");