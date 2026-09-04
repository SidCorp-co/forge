CREATE TABLE "memory_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"text_content" text NOT NULL,
	"context_prefix" text NOT NULL,
	"embedding" vector(1536),
	"generation" integer NOT NULL,
	"text_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "memory_chunks"."context_prefix" || ' ' || "memory_chunks"."text_content")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "chunk_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "chunked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD CONSTRAINT "memory_chunks_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_chunks_memory_chunk_uq" ON "memory_chunks" USING btree ("memory_id","chunk_index");--> statement-breakpoint
CREATE INDEX "memory_chunks_embedding_hnsw_idx" ON "memory_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_chunks_text_search_idx" ON "memory_chunks" USING gin ("text_search");