ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "schedule_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_schedule_run_id_schedule_runs_id_fk";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_schedule_run_id_schedule_runs_id_fk" FOREIGN KEY ("schedule_run_id") REFERENCES "public"."schedule_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_schedule_run_idx" ON "issues" USING btree ("schedule_run_id") WHERE schedule_run_id IS NOT NULL;
