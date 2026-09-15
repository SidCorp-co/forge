-- ISS-1022 — the indexes the list, analytics and pulse reads needed, and the
-- bounded form of the retry-rescue recursion.
--
-- Additive in every statement: six indexes and one function. No column, no
-- constraint, no drop, no row written. Running it backwards is six
-- `DROP INDEX IF EXISTS` and one `DROP FUNCTION IF EXISTS`, and nothing is lost.
--
-- Measured on the beta deployment 2026-09-15, before this landed: `activity_log`
-- 87,576 sequential scans for 2,795,162,646 tuples, `usage_records` 267,850 for
-- 5,676,433,037, `issues` 315,731, `pipeline_runs` 116,032. Where a composite
-- whose leading column went unconstrained already existed, the planner did not
-- fall back to a sequential scan — it scanned the WHOLE index instead, which
-- reads as an index scan in a plan and costs like a table scan: 1,010 for a bare
-- `recorded_at >=`, 316 for a bare `started_at >=`, 4,546 for a bare
-- `created_at >=`. That is why three of these six duplicate a column another
-- index already carries in second position.
--
-- Six and not the seven the filing named: `(action, created_at)` on `activity_log` was measured
-- and dropped. At this deployment's `created_at` correlation (0.969) the single-column index
-- below is nearly sequential to scan, and it beat the composite 105 to 1,160 on an
-- action-filtered 24-hour window and 26.4ms to 32.5ms on an action-filtered scan of half the
-- table. The composite won nothing and would have cost every write to the busiest table here.
--
-- cm:guard NOT `CONCURRENTLY`, and it cannot be: `src/db/migrate.ts` wraps the
-- whole run in one transaction and a CONCURRENTLY build is refused inside one. Each
-- statement therefore holds a write lock on its table until that transaction commits. The
-- largest of these tables was 127,806 live rows at the time of writing, which is seconds,
-- and the container is not serving while it migrates - so the lock is paid, not avoided,
-- and this comment is where that price is stated.
CREATE INDEX IF NOT EXISTS "activity_log_created_at_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_issue_created_idx" ON "comments" USING btree ("issue_id","created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_runs_started_at_only_idx" ON "pipeline_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_recorded_at_idx" ON "usage_records" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_questions_issue_idx" ON "agent_questions" USING btree ("issue_id");
--> statement-breakpoint
-- cm:guard the recursion is bounded at its ANCHOR, which the view in
-- `0175_iss826_retry_rescues.sql` cannot be: a caller filtering that view's
-- output walks every `retry_of` chain in `jobs` first and discards the result.
-- Measured on beta for one project over 30 days: 61.0ms and 9,089 recursion rows
-- through the view, 25.8ms and 72 through this, for the identical 40 output rows.
-- The two are equivalent because `project_id` and `rescued_at` are ANCHOR
-- invariants — the recursive term below carries both forward from the anchor row
-- and never takes them from the parent it walks to — so seeding the anchor with
-- them selects exactly the rescued jobs the outer filter used to keep. The view
-- itself is deliberately left in place: `retry-rescues-view-e2e.test.ts` and
-- `failure-taxonomy-policy-e2e.test.ts` read it, and an applied migration is
-- never rewritten.
-- cm:guard a NULL `project_ids` means EVERY project and an empty array means NO
-- rows. They are two different answers and the caller gets the one it asked for:
-- `pipeline/retry-rescue-alert.ts` runs cross-tenant on the sweeper and passes
-- NULL, while a caller whose visible-project list came back empty passes the
-- empty array and must get nothing rather than the whole fleet. Collapsing them
-- would hand one tenant's rescues to a caller entitled to none.
-- cm:guard `since` is INCLUSIVE (`>=`), matching the `rescued_at >= ...` the three
-- callers used against the view, so a rescue landing exactly on the boundary
-- stays counted rather than silently dropping out of the window.
CREATE OR REPLACE FUNCTION "retry_rescues_since"(
  "project_ids" uuid[],
  "since" timestamptz
) RETURNS TABLE (
  "rescued_job_id" uuid,
  "project_id" uuid,
  "issue_id" uuid,
  "job_type" text,
  "rescued_at" timestamptz,
  "original_failed_job_id" uuid,
  "failure_kind" text,
  "failure_reason" text
) LANGUAGE sql STABLE AS $$
WITH RECURSIVE ancestors AS (
  SELECT
    child.id AS rescued_job_id,
    child.project_id,
    child.issue_id,
    child.type AS job_type,
    child.finished_at AS rescued_at,
    parent.id AS ancestor_id,
    parent.retry_of,
    parent.status AS ancestor_status,
    parent.failure_kind AS ancestor_failure_kind,
    parent.failure_reason AS ancestor_failure_reason,
    1 AS depth,
    ARRAY[child.id, parent.id] AS path
  FROM jobs child
  JOIN jobs parent ON parent.id = child.retry_of
  WHERE child.status = 'done'
    AND child.retry_of IS NOT NULL
    AND (project_ids IS NULL OR child.project_id = ANY(project_ids))
    AND (since IS NULL OR child.finished_at >= since)

  UNION ALL

  SELECT
    ancestors.rescued_job_id,
    ancestors.project_id,
    ancestors.issue_id,
    ancestors.job_type,
    ancestors.rescued_at,
    parent.id,
    parent.retry_of,
    parent.status,
    parent.failure_kind,
    parent.failure_reason,
    ancestors.depth + 1,
    ancestors.path || parent.id
  FROM ancestors
  JOIN jobs parent ON parent.id = ancestors.retry_of
  WHERE NOT parent.id = ANY(ancestors.path)
)
SELECT DISTINCT ON (rescued_job_id)
  rescued_job_id,
  project_id,
  issue_id,
  job_type,
  rescued_at,
  ancestor_id AS original_failed_job_id,
  ancestor_failure_kind AS failure_kind,
  COALESCE(ancestor_failure_reason, ancestor_failure_kind, 'unknown') AS failure_reason
FROM ancestors
WHERE ancestor_status = 'failed'
ORDER BY rescued_job_id, depth DESC;
$$;
