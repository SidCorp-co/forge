-- ISS-564 — Knowledge subsystem P0 (epic ISS-563). Foundation table only;
-- no reader/writer wired this phase. Mirrors the `memories` DDL: nullable
-- pgvector embedding, GENERATED ALWAYS tsvector, HNSW cosine + GIN indexes.
-- Hand-written + registered in _journal.json.
CREATE TABLE IF NOT EXISTS "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"injection" text DEFAULT 'on_demand' NOT NULL,
	"confidence" text DEFAULT 'inferred' NOT NULL,
	"related_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"authored_by" text DEFAULT 'agent' NOT NULL,
	"embedding" vector(1536),
	"text_search" tsvector GENERATED ALWAYS AS (to_tsvector('english', left("title" || ' ' || "body", 100000))) STORED,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entries_project_kind_idx" ON "knowledge_entries" USING btree ("project_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_entries_project_slug_uq" ON "knowledge_entries" USING btree ("project_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entries_embedding_hnsw_idx" ON "knowledge_entries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_entries_text_search_idx" ON "knowledge_entries" USING gin ("text_search");
