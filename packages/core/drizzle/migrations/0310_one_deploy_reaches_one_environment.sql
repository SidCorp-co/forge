CREATE TABLE "deploy_locks" (
	"project_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"run_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reclaimed_from_run_id" uuid,
	"reclaimed_at" timestamp with time zone,
	CONSTRAINT "deploy_locks_project_id_environment_pk" PRIMARY KEY("project_id","environment"),
	CONSTRAINT "deploy_locks_environment_chk" CHECK (environment IN ('preview', 'live'))
);
--> statement-breakpoint
ALTER TABLE "deploy_locks" ADD CONSTRAINT "deploy_locks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_locks" ADD CONSTRAINT "deploy_locks_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deploy_locks_run_idx" ON "deploy_locks" USING btree ("run_id");