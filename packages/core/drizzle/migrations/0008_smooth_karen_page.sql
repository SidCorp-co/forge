CREATE TABLE "project_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" text[] DEFAULT ARRAY['issue.statusChanged']::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "project_webhooks" ADD CONSTRAINT "project_webhooks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_webhooks_project_id_idx" ON "project_webhooks" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_project_source_external_id_uq" ON "issues" USING btree ("project_id","source","external_id") WHERE external_id IS NOT NULL;