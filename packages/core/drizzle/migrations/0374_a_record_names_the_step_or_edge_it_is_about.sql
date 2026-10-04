CREATE TABLE "requirement_criterion_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"code" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"step_id" text,
	"edge_from" text,
	"edge_to" text,
	"edge_label" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_criterion_steps_code_chk" CHECK ("requirement_criterion_steps"."code" ~ '^BC-[1-9][0-9]*$'),
	CONSTRAINT "requirement_criterion_steps_node_chk" CHECK (("requirement_criterion_steps"."step_id" IS NOT NULL AND "requirement_criterion_steps"."edge_from" IS NULL AND "requirement_criterion_steps"."edge_to" IS NULL AND "requirement_criterion_steps"."edge_label" IS NULL) OR ("requirement_criterion_steps"."step_id" IS NULL AND "requirement_criterion_steps"."edge_from" IS NOT NULL AND "requirement_criterion_steps"."edge_to" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_arc_chk";--> statement-breakpoint
ALTER TABLE "suggestions" DROP CONSTRAINT "suggestions_kind_chk";--> statement-breakpoint
DROP INDEX "suggestions_open_twin_uq";--> statement-breakpoint
ALTER TABLE "workflow_builds" ADD COLUMN "step_ids" text[];--> statement-breakpoint
ALTER TABLE "suggestions" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "step_id" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "edge_from" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "edge_to" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "edge_label" text;--> statement-breakpoint
ALTER TABLE "requirement_criterion_steps" ADD CONSTRAINT "requirement_criterion_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_criterion_steps" ADD CONSTRAINT "requirement_criterion_steps_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_criterion_steps" ADD CONSTRAINT "requirement_criterion_steps_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_criterion_steps" ADD CONSTRAINT "requirement_criterion_steps_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requirement_criterion_steps_workflow_idx" ON "requirement_criterion_steps" USING btree ("project_id","workflow_id");--> statement-breakpoint
CREATE INDEX "requirement_criterion_steps_criterion_idx" ON "requirement_criterion_steps" USING btree ("requirement_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_criterion_steps_node_uq" ON "requirement_criterion_steps" USING btree ("requirement_id","code","workflow_id",coalesce("step_id", ''),coalesce("edge_from", ''),coalesce("edge_to", ''),coalesce("edge_label", ''));--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_workflow_id_project_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."project_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "suggestions_workflow_idx" ON "suggestions" USING btree ("workflow_id","status") WHERE workflow_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "suggestions_open_twin_uq" ON "suggestions" USING btree ("kind",coalesce("requirement_id", "issue_id", "feedback_id", "workflow_id"),"fingerprint") WHERE status = 'proposed';--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_arc_chk" CHECK (num_nonnulls("suggestions"."requirement_id", "suggestions"."issue_id", "suggestions"."feedback_id", "suggestions"."workflow_id") = 1);--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_kind_chk" CHECK ("suggestions"."kind" IN ('requirement_draft', 'revision_diff', 'readiness', 'breakdown', 'triage', 'duplicate', 'feedback_triage', 'design_change'));--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_node_chk" CHECK (("feedback"."step_id" IS NULL AND "feedback"."edge_from" IS NULL AND "feedback"."edge_to" IS NULL AND "feedback"."edge_label" IS NULL) OR ("feedback"."workflow_id" IS NOT NULL AND (("feedback"."step_id" IS NOT NULL AND "feedback"."edge_from" IS NULL AND "feedback"."edge_to" IS NULL AND "feedback"."edge_label" IS NULL) OR ("feedback"."step_id" IS NULL AND "feedback"."edge_from" IS NOT NULL AND "feedback"."edge_to" IS NOT NULL))));