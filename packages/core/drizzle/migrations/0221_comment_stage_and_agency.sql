ALTER TABLE "comments" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "author_agency" text;--> statement-breakpoint
CREATE INDEX "comments_stage_created_at_idx" ON "comments" USING btree ("stage","created_at") WHERE stage IS NOT NULL;