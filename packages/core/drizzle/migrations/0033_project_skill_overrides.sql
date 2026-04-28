CREATE TABLE "project_skill_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"skill_md_override" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_skill_overrides" ADD CONSTRAINT "project_skill_overrides_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skill_overrides" ADD CONSTRAINT "project_skill_overrides_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_skill_overrides_project_skill_uq" ON "project_skill_overrides" USING btree ("project_id","skill_id");--> statement-breakpoint
CREATE INDEX "project_skill_overrides_project_id_idx" ON "project_skill_overrides" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_skill_overrides_skill_id_idx" ON "project_skill_overrides" USING btree ("skill_id");
