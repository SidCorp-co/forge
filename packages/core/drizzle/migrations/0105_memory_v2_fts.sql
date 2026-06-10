-- memory-v2 phase 1 (docs/proposals/memory-v2-cognitive-layer.md) — keyword
-- retrieval via Postgres FTS, replacing the predecessor's Qdrant BM25 sparse
-- vectors with zero new infrastructure.
--
-- text_search is GENERATED ALWAYS so it can never drift from text_content
-- and the app never writes it. left(...) caps the input at the same 100k the
-- REST/MCP write schema allows; to_tsvector with an explicit config is
-- immutable as required for stored generated columns. Existing rows are
-- populated by the ALTER itself (table rewrite).
--
-- Hand-written; registered in _journal.json (drizzle-kit generate remains
-- blocked by the pre-existing meta-snapshot collision, see 0084+ headers).

ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "text_search" tsvector GENERATED ALWAYS AS (to_tsvector('english', left("text_content", 100000))) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_text_search_idx" ON "memories" USING gin ("text_search");
