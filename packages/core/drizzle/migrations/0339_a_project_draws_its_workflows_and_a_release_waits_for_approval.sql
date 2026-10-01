CREATE TABLE "project_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"flow" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"refreshed_at_sha" text NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"written_by_user" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workflows_kind_chk" CHECK ("project_workflows"."kind" IN ('flow', 'state')),
	CONSTRAINT "project_workflows_status_chk" CHECK ("project_workflows"."status" IN ('writing', 'current', 'rechecking')),
	CONSTRAINT "project_workflows_sha_chk" CHECK ("project_workflows"."refreshed_at_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "project_workflows_revision_chk" CHECK ("project_workflows"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "release_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"requested_by_user" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_environment" text NOT NULL,
	"evidence_commit" text NOT NULL,
	"evidence_reading" text NOT NULL,
	"note" text,
	"decision" text,
	"decided_by_user" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "release_approvals_decision_chk" CHECK ("release_approvals"."decision" IS NULL OR "release_approvals"."decision" IN ('approved', 'returned')),
	CONSTRAINT "release_approvals_decided_chk" CHECK (("release_approvals"."decision" IS NULL) = ("release_approvals"."decided_by_user" IS NULL) AND ("release_approvals"."decision" IS NULL) = ("release_approvals"."decided_at" IS NULL)),
	CONSTRAINT "release_approvals_reason_chk" CHECK (("release_approvals"."decision" = 'returned') = ("release_approvals"."reason" IS NOT NULL)),
	CONSTRAINT "release_approvals_commit_chk" CHECK ("release_approvals"."evidence_commit" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_written_by_user_users_id_fk" FOREIGN KEY ("written_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_requested_by_user_users_id_fk" FOREIGN KEY ("requested_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_decided_by_user_users_id_fk" FOREIGN KEY ("decided_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_workflows_flow_uq" ON "project_workflows" USING btree ("project_id","flow");--> statement-breakpoint
CREATE INDEX "project_workflows_project_idx" ON "project_workflows" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "release_approvals_one_pending_uq" ON "release_approvals" USING btree ("run_id") WHERE "release_approvals"."decision" IS NULL;--> statement-breakpoint
CREATE INDEX "release_approvals_run_idx" ON "release_approvals" USING btree ("run_id","requested_at");--> statement-breakpoint
CREATE INDEX "release_approvals_project_idx" ON "release_approvals" USING btree ("project_id","requested_at");