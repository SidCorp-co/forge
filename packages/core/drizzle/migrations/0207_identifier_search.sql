-- ISS-907: identifier-aware keyword matching. One IMMUTABLE split function shared by the four
-- generated ident_search columns below and by every identifier query (schema-types.ts:identifierTsQuery):
-- camelCase boundaries become spaces, then runs of _ / . : - become spaces, then lower-case.
-- STORED generated columns rewrite each table once at migration time.
CREATE OR REPLACE FUNCTION forge_identifier_words(input text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN lower(regexp_replace(regexp_replace(input, '([a-z0-9])([A-Z])', '\1 \2', 'g'), '[_/.:-]+', ' ', 'g'));--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "ident_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', forge_identifier_words(left("issues"."title" || ' ' || coalesce("issues"."description", ''), 100000)))) STORED;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN "ident_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', forge_identifier_words(left("knowledge_entries"."title" || ' ' || "knowledge_entries"."body", 100000)))) STORED;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "ident_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', forge_identifier_words(left("memories"."text_content", 100000)))) STORED;--> statement-breakpoint
ALTER TABLE "memory_chunks" ADD COLUMN "ident_search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', forge_identifier_words("memory_chunks"."context_prefix" || ' ' || "memory_chunks"."text_content"))) STORED;--> statement-breakpoint
CREATE INDEX "issues_ident_search_idx" ON "issues" USING gin ("ident_search");--> statement-breakpoint
CREATE INDEX "knowledge_entries_ident_search_idx" ON "knowledge_entries" USING gin ("ident_search");--> statement-breakpoint
CREATE INDEX "memories_ident_search_idx" ON "memories" USING gin ("ident_search");--> statement-breakpoint
CREATE INDEX "memory_chunks_ident_search_idx" ON "memory_chunks" USING gin ("ident_search");