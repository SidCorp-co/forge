CREATE TABLE "app_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"chat_provider_id" text,
	"chat_model" text,
	"retrieval_top_k" integer DEFAULT 10 NOT NULL,
	"retrieval_min_score" real DEFAULT 0 NOT NULL,
	"enabled_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system_prompt_override" text,
	"last_backfill_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_config_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE "domain_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"manifest" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "retrieval_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"query" text NOT NULL,
	"hit_count" integer NOT NULL,
	"top_score" real,
	"model" text,
	"duration_ms" integer,
	"source" text DEFAULT 'api-search' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_config" ADD CONSTRAINT "app_config_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retrieval_analytics" ADD CONSTRAINT "retrieval_analytics_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retrieval_analytics_project_created_idx" ON "retrieval_analytics" USING btree ("project_id","created_at");