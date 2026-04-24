-- Requires pgvector extension (ADR 0011). Postgres image must ship pgvector
-- (docker-compose uses pgvector/pgvector:pg17).
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_ref" text NOT NULL,
	"text_content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"registered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"scope" text NOT NULL,
	"project_id" uuid,
	"prompt" text NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"eval_score" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_registrations" ADD CONSTRAINT "skill_registrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_registrations" ADD CONSTRAINT "skill_registrations_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_registrations" ADD CONSTRAINT "skill_registrations_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_project_source_idx" ON "memories" USING btree ("project_id","source");--> statement-breakpoint
CREATE INDEX "memories_project_source_ref_idx" ON "memories" USING btree ("project_id","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_project_source_ref_uq" ON "memories" USING btree ("project_id","source","source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_registrations_project_stage_uq" ON "skill_registrations" USING btree ("project_id","stage");--> statement-breakpoint
CREATE INDEX "skill_registrations_skill_id_idx" ON "skill_registrations" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skills_project_id_idx" ON "skills" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "skills_scope_idx" ON "skills" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_name_global_uq" ON "skills" USING btree ("name") WHERE scope = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "skills_project_name_uq" ON "skills" USING btree ("project_id","name") WHERE scope = 'project';--> statement-breakpoint
CREATE INDEX "memories_embedding_hnsw_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);