-- ISS-381 (Part 2, unit 2.1) — structured review/test verdict.
--
-- Promotes the review verdict (pass/needs_fix/no_change) and test result
-- (pass/fail) out of the `issue_step_contexts.payload` jsonb into a queryable,
-- indexable column so project-scoped pass-rate + review approve-rate (and their
-- trends) become aggregate-queryable for the ISS-379 dashboard.
--
-- Placed on `issue_step_contexts` (NOT `jobs`): the single writer of this data
-- is writeIssueContext() (issue-context-store.ts), which already writes this row
-- and has the verdict in hand but has no jobId in scope. issue_step_contexts
-- already carries project_id + created_at for aggregation.
--
-- Nullable + backfill-free: historical rows stay NULL (only review/test rows
-- ever carry a value). The partial index supports the windowed per-project
-- pass_rate/approve_rate reads without bloating non-verdict rows.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision (see 0087-0093 headers). The runtime migrator applies this row from
-- _journal.json.

ALTER TABLE "issue_step_contexts" ADD COLUMN IF NOT EXISTS "verdict" text;

CREATE INDEX IF NOT EXISTS "issue_step_contexts_verdict_idx"
  ON "issue_step_contexts" ("project_id", "step", "created_at")
  WHERE "verdict" IS NOT NULL;
