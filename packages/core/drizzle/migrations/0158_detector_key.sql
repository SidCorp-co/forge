ALTER TABLE "issues" ADD COLUMN "detector_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "issues_detector_key_live_uq" ON "issues" ("project_id","detector_key")
	WHERE "detector_key" IS NOT NULL AND "status" <> 'closed';
--> statement-breakpoint
CREATE INDEX "issues_project_created_via_idx" ON "issues" ("project_id","created_via");
