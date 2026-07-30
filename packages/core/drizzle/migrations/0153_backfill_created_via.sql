-- ISS-756 review M2 — partial backfill for `issues.created_via` on rows written
-- before this column existed. Heuristic, not exact: it infers channel from
-- shape (parent_issue_id / category / status) rather than a stored fact, so
-- a human-authored issue that happens to match one of these shapes is
-- mislabeled Forge Agent. Left NULL (= human) for everything else, matching
-- the accepted no-backfill default for the remaining legacy rows.

-- decompose children: created via the pipeline decompose flow.
UPDATE "issues" SET "created_via" = 'pipeline'
WHERE "created_via" IS NULL AND "parent_issue_id" IS NOT NULL;
--> statement-breakpoint

-- nightly memory-consolidation schedule always drafts this category.
UPDATE "issues" SET "created_via" = 'schedule'
WHERE "created_via" IS NULL AND "category" = 'knowledge-promotion';
--> statement-breakpoint

-- skill template-propagation always drafts this category+status pair.
UPDATE "issues" SET "created_via" = 'system'
WHERE "created_via" IS NULL AND "category" = 'skills' AND "status" = 'draft';
