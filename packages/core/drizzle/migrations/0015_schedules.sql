CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"prompt" text NOT NULL,
	"runner" text DEFAULT 'antigravity' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"target_project_slug" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_status" text,
	"last_session_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_project_enabled_idx" ON "schedules" USING btree ("project_id","enabled");--> statement-breakpoint
CREATE INDEX "schedules_next_run_at_idx" ON "schedules" USING btree ("next_run_at") WHERE enabled = true;