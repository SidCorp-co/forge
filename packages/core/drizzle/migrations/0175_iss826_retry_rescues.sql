CREATE OR REPLACE VIEW "retry_rescues" AS
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

-- A threshold alert must remain unique for its reason/window even after its
-- recipient reads it. Other notification types deliberately allow re-alerts.
CREATE UNIQUE INDEX "notifications_retry_rescue_threshold_resolution_key_uq"
  ON "notifications" ("resolution_key")
  WHERE "type" = 'retry_rescue_threshold';
