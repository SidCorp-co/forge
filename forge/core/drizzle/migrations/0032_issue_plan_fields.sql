-- Issue extension fields used by the autonomous /forge-* skill pipeline.
-- ISS-293: forge_issues MCP tool needs to read/write plan + acceptanceCriteria
-- + suggestedSolution + sessionContext, which existed in the legacy Strapi
-- schema but were dropped in the Hono+Drizzle port. All four are nullable so
-- existing rows remain valid; no backfill required.
ALTER TABLE "issues"
  ADD COLUMN "plan" text,
  ADD COLUMN "acceptance_criteria" text,
  ADD COLUMN "suggested_solution" text,
  ADD COLUMN "session_context" jsonb;
