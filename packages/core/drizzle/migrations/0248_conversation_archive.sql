ALTER TABLE "conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "conversations_archived_idx" ON "conversations" USING btree ("archived_at");