-- memory-v2 phase 0 (docs/proposals/memory-v2-cognitive-layer.md) — schema
-- groundwork for the cognitive memory layer:
--   1. retrieval_count / last_retrieved_at — usage tracking, bumped on
--      semantic-search hits (phase 2). Prerequisite for decay/consolidation:
--      you can't decay what you don't measure.
--   2. archived_at — soft delete used by the decay + consolidation jobs.
--      Archived rows are excluded from all read surfaces; purge is a later,
--      separate step. LLM-driven pruning NEVER hard-deletes.
--   3. embedding DROP NOT NULL — degraded writes (phase 1): when the
--      embeddings service is down the row is stored without a vector (still
--      FTS-searchable after 0105) and a backfill job re-embeds it. Semantic
--      search filters `embedding IS NOT NULL`.
--
-- Hand-written because drizzle-kit generate is blocked by a pre-existing
-- meta-snapshot collision (see 0084–0103 headers); the runtime migrator
-- applies this from _journal.json.

ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "retrieval_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "last_retrieved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "memories" ALTER COLUMN "embedding" DROP NOT NULL;
