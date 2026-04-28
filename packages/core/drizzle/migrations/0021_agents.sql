CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"focus_areas" jsonb DEFAULT '["feature-gaps","journey-completeness","polish","accessibility","ux-improvements"]'::jsonb NOT NULL,
	"custom_instructions" text,
	"schedule" text DEFAULT 'off' NOT NULL,
	"approval_mode" text DEFAULT 'preview' NOT NULL,
	"max_proposals" integer DEFAULT 10 NOT NULL,
	"exclude_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_template" text,
	"reindex_prompt_template" text,
	"knowledge" text,
	"memory" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_project_type_idx" ON "agents" USING btree ("project_id","type");