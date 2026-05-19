-- ISS-172 Slice A: unify project_devices into runners.
--
-- Before this migration: a device could only be the `claude-code` runner of
-- ONE project (partial unique index on `(device_id, type)`), and the device
-- pool lived in `project_devices`. Two sources of truth, single-project cap.
--
-- After: `runners` is the only home for device→project bindings. A device
-- can be a runner for N projects (unique on `(project_id, device_id, type)`).
--
-- Backfill BEFORE dropping the source table and BEFORE tightening the index
-- so a partial fail rolls back cleanly inside the transaction.

BEGIN;

INSERT INTO runners (project_id, type, host, device_id, name, capabilities, status, last_seen_at)
SELECT
  pd.project_id,
  'claude-code'::text,
  'device'::text,
  pd.device_id,
  COALESCE(d.name, 'device'),
  '{}'::jsonb,
  CASE
    WHEN d.status = 'online' AND d.last_seen_at IS NOT NULL THEN 'online'
    ELSE 'offline'
  END,
  d.last_seen_at
FROM project_devices pd
JOIN devices d ON d.id = pd.device_id
WHERE NOT EXISTS (
  SELECT 1 FROM runners r
  WHERE r.project_id = pd.project_id
    AND r.device_id  = pd.device_id
    AND r.type       = 'claude-code'
);

DROP INDEX IF EXISTS runners_device_type_uq;

CREATE UNIQUE INDEX runners_project_device_type_uq
  ON runners (project_id, device_id, type)
  WHERE device_id IS NOT NULL;

DROP TABLE IF EXISTS project_devices;

COMMIT;
