-- ISS-618 — script-kind schedules: run a standalone sandboxed Node.js script
-- on a cron cadence, no agent_sessions row / no Claude runner. All additive;
-- existing rows default kind='prompt' and are read unchanged.
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'prompt' NOT NULL;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "script" text;
--> statement-breakpoint
ALTER TABLE "schedules" ALTER COLUMN "prompt" DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"output" text,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_runs_schedule_created_idx" ON "schedule_runs" ("schedule_id","created_at");
