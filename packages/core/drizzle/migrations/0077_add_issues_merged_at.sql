-- ISS-232 Phase 1 — Dispatch & Load-Balance v2 — git-aware L2 dependency gate.
--
-- The Layer-2 dependency gate previously asked "is the parent issue in a
-- terminal status (released | closed)?" That test is wrong for trunk-based
-- repos where children depend on the parent's *merge*, not its status.
-- An issue can be closed without its branch having been merged (manual
-- close, abandoned work), and a merged branch can be reopened. The status
-- enum doesn't carry that information.
--
-- Add `merged_at` so the gate can ask "has the parent been merged?" and
-- have the state-machine writer manage the column whenever an issue
-- transitions out of `pipelineConfig.mergeStates.baseBranch` (default
-- `released`). Manual override available via direct UPDATE for abandoned
-- issues that need to unblock their children.
--
-- Partial index — picker's L2 EXISTS sub-query filters on `merged_at IS
-- NULL` (blocking parents). Indexing only the non-NULL rows would invert
-- the workload; leaving the predicate broad covers both lookups.

ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "merged_at" timestamptz;

COMMENT ON COLUMN "issues"."merged_at" IS
  'Set by the state-machine when an issue transitions OUT of pipelineConfig.mergeStates.baseBranch (default "released"). NULL = parent has not yet merged; downstream issues with kind=blocks edges to this issue stay gated. Operator may UPDATE directly for abandoned issues.';

CREATE INDEX IF NOT EXISTS "idx_issues_merged_at"
  ON "issues" ("merged_at")
  WHERE "merged_at" IS NOT NULL;

-- Backfill — legacy issues that closed without leaving a merge trail are
-- treated as merged at their last update. Without this, every existing
-- dependency edge to a long-closed parent would suddenly start blocking
-- after deploy. `updated_at` is the closest signal we have to "when did
-- this issue become done"; precision doesn't matter — the gate only cares
-- about NULL vs non-NULL.
UPDATE "issues"
SET "merged_at" = "updated_at"
WHERE "status" IN ('released', 'closed')
  AND "merged_at" IS NULL;
