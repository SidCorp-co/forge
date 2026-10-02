CREATE TABLE "project_workflow_designs" (
	"workflow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"proposed_by_user" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"decided_by_user" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	CONSTRAINT "project_workflow_designs_workflow_id_revision_pk" PRIMARY KEY("workflow_id","revision"),
	CONSTRAINT "project_workflow_designs_decision_chk" CHECK ("project_workflow_designs"."decision" IS NULL OR "project_workflow_designs"."decision" IN ('approve', 'return')),
	CONSTRAINT "project_workflow_designs_decided_chk" CHECK (("project_workflow_designs"."decision" IS NULL) = ("project_workflow_designs"."decided_by_user" IS NULL) AND ("project_workflow_designs"."decision" IS NULL) = ("project_workflow_designs"."decided_at" IS NULL)),
	CONSTRAINT "project_workflow_designs_reason_chk" CHECK ("project_workflow_designs"."decision" IS DISTINCT FROM 'return' OR "project_workflow_designs"."reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "workflow_builds" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"linked_by_user" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_workflows" DROP CONSTRAINT "project_workflows_status_chk";--> statement-breakpoint
ALTER TABLE "project_workflows" DROP CONSTRAINT "project_workflows_sha_chk";--> statement-breakpoint
ALTER TABLE "project_workflows" ALTER COLUMN "refreshed_at_sha" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workflows" ADD COLUMN "design_status" text;--> statement-breakpoint
ALTER TABLE "project_workflows" ADD COLUMN "design_fingerprint" text;--> statement-breakpoint
ALTER TABLE "project_workflows" ADD COLUMN "approved_revision" integer;--> statement-breakpoint
ALTER TABLE "project_workflow_designs" ADD CONSTRAINT "project_workflow_designs_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workflow_designs" ADD CONSTRAINT "project_workflow_designs_proposed_by_user_users_id_fk" FOREIGN KEY ("proposed_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_workflow_designs" ADD CONSTRAINT "project_workflow_designs_decided_by_user_users_id_fk" FOREIGN KEY ("decided_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_builds" ADD CONSTRAINT "workflow_builds_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_builds" ADD CONSTRAINT "workflow_builds_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_builds" ADD CONSTRAINT "workflow_builds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_builds" ADD CONSTRAINT "workflow_builds_linked_by_user_users_id_fk" FOREIGN KEY ("linked_by_user") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_builds_workflow_idx" ON "workflow_builds" USING btree ("workflow_id");--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_design_status_chk" CHECK ("project_workflows"."design_status" IS NULL OR "project_workflows"."design_status" IN ('draft', 'proposed', 'approved', 'returned'));--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_design_approved_chk" CHECK ("project_workflows"."design_status" IS DISTINCT FROM 'approved' OR "project_workflows"."approved_revision" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_status_chk" CHECK ("project_workflows"."status" IN ('writing', 'current', 'rechecking', 'designed'));--> statement-breakpoint
ALTER TABLE "project_workflows" ADD CONSTRAINT "project_workflows_sha_chk" CHECK ("project_workflows"."refreshed_at_sha" IS NULL OR "project_workflows"."refreshed_at_sha" ~ '^[0-9a-f]{40}$');