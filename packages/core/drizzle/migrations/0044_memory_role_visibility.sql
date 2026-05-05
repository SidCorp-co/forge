-- ISS-27 — role/visibility access control + retention pruning lifecycle for memories.
-- Ports the old Qdrant-system role gating onto the pgvector-backed `memories`
-- table and adds two btree indexes used by search filtering and the prune
-- sweeper. Existing rows backfill via column defaults — no app-level migration
-- needed.

ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'dev',
  ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS "retrieval_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "category" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memories_project_role_idx"
  ON "memories" ("project_id", "role");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "memories_retention_idx"
  ON "memories" ("retrieval_count", "updated_at");
--> statement-breakpoint

-- Stale-zero prune predicate uses created_at, not updated_at, so the
-- retention_idx alone can't serve it. Partial index keeps the second
-- index small (only rows that are pruning candidates).
CREATE INDEX IF NOT EXISTS "memories_stale_zero_idx"
  ON "memories" ("created_at")
  WHERE "retrieval_count" = 0;
--> statement-breakpoint

-- Prune cascades `DELETE FROM knowledge_edges WHERE source_memory_id = ANY(...)`
-- with up-to-10k id batches. Without this index the daily sweep degrades to a
-- seq scan once the edges table grows. Partial WHERE keeps the index small
-- (most edges have non-null source_memory_id but we skip null entries either
-- way).
CREATE INDEX IF NOT EXISTS "knowledge_edges_source_memory_idx"
  ON "knowledge_edges" ("source_memory_id")
  WHERE "source_memory_id" IS NOT NULL;
