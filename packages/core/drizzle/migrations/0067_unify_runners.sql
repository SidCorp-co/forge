-- ISS-172 Slice A: unify project_devices into runners.
--
-- Before this migration: a device could only be the `claude-code` runner of
-- ONE project (partial unique index on `(device_id, type)`), and the device
-- pool lived in `project_devices`. Two sources of truth, single-project cap.
--
-- After: `runners` is the only home for device→project bindings. A device
-- can be a runner for N projects (unique on `(project_id, device_id, type)`).
--
-- Drop the OLD partial unique index BEFORE the backfill: any device paired to
-- project A (existing runner row) that also sits in project B's pool would
-- otherwise violate `runners_device_type_uq` on `(device_id, type)` mid-INSERT
-- and roll the whole transaction back. Then backfill, then install the new
-- per-project unique index, then drop the source table.
--
-- The BEGIN/COMMIT this file used to carry is gone, and its absence is the
-- point. drizzle runs EVERY migration of a run inside one transaction it opens
-- itself (`pg-core/dialect.ts:migrate`), and this file carries no statement
-- breakpoint, so it reached the server as one multi-statement string over the
-- simple protocol: the `BEGIN` was a no-op inside a live
-- transaction, and the `COMMIT` ended DRIZZLE's. Every migration numbered above
-- 0067 therefore auto-committed statement by statement — 171 of them, each free
-- to half-apply and still be recorded as applied. Nothing reported it, because
-- the only symptom is a failure that does not roll back. Found while writing
-- 0238, whose `ON COMMIT DROP` temp table was dropped under it (ISS-1001).
-- Editing an applied migration is inert here: drizzle decides what to replay
-- from `created_at` alone and never compares the stored hash.

DROP INDEX IF EXISTS runners_device_type_uq;

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

CREATE UNIQUE INDEX runners_project_device_type_uq
  ON runners (project_id, device_id, type)
  WHERE device_id IS NOT NULL;

DROP TABLE IF EXISTS project_devices;
