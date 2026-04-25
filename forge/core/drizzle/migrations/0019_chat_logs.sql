CREATE TABLE "chat_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"project_slug" text NOT NULL,
	"user_key" text,
	"query" text NOT NULL,
	"reply" text,
	"model" text,
	"rag_context" jsonb,
	"tool_calls" jsonb,
	"usage" jsonb,
	"iterations" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer,
	"error" text,
	"query_intent" text,
	"condensed_query" text,
	"source" text DEFAULT 'web' NOT NULL,
	"quality_signals" jsonb,
	"qa_rating" text,
	"qa_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_logs_project_created_idx" ON "chat_logs" USING btree ("project_slug","created_at");--> statement-breakpoint
CREATE INDEX "chat_logs_session_id_idx" ON "chat_logs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "chat_logs_qa_rating_idx" ON "chat_logs" USING btree ("qa_rating");