ALTER TABLE "issues" ADD COLUMN "release_batch_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_release_batch_run_id_pipeline_runs_id_fk"
	FOREIGN KEY ("release_batch_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "issues_release_batch_run_id_idx" ON "issues" USING btree ("release_batch_run_id")
  WHERE "release_batch_run_id" IS NOT NULL;
--> statement-breakpoint
-- One in-flight batch per project. Mirrors jobs_pm_per_project_unique_idx so a
-- second concurrent Batch Release loses on unique-violation instead of racing
-- two prod deploys.
CREATE UNIQUE INDEX "jobs_release_batch_per_project_unique_idx" ON "jobs" ("project_id")
  WHERE "type" = 'release_batch' AND "status" IN ('queued','dispatched','running');
