-- Name the intervention by what it DID, not by the only thing it used to be.
--
-- 0117 built this view when `job_events.kind='intervention'` had exactly one
-- writer, so it hardcoded `'manual_cancel'`. A second writer (the operator
-- resume for a held job) would have been counted correctly and labelled wrongly:
-- every resume charted as a cancel in VISION §1 metric ②, which is worse than
-- missing, because it reads as an operator killing work they actually rescued.
--
-- The label now comes from `data->>'action'`, which every writer already stamps.
-- Rows written before the resume path existed carry `action='cancel'`, so the
-- COALESCE arm is for hand-inserted rows only and keeps their old name.
--
-- Idempotent (CREATE OR REPLACE). The other two arms are unchanged from 0117.
CREATE OR REPLACE VIEW "issue_intervention_events" AS
SELECT
  'wedge'::text         AS source,
  n.project_id          AS project_id,
  n.issue_id            AS issue_id,
  n.created_at          AS occurred_at,
  n.title               AS detail
FROM notifications n
WHERE n.type = 'pipeline_wedge'
UNION ALL
SELECT
  concat('manual_', COALESCE(NULLIF(e.data->>'action', ''), 'cancel')) AS source,
  j.project_id          AS project_id,
  j.issue_id            AS issue_id,
  e.ts                  AS occurred_at,
  COALESCE(e.data->>'reason', 'manual job intervention') AS detail
FROM job_events e
JOIN jobs j ON j.id = e.job_id
WHERE e.kind = 'intervention'
UNION ALL
SELECT
  'user_run_flip'::text AS source,
  pr.project_id         AS project_id,
  pr.issue_id           AS issue_id,
  kt.created_at         AS occurred_at,
  concat('run ', COALESCE(kt.from_status, '?'), '→', kt.to_status,
         COALESCE(' (' || kt.reason || ')', '')) AS detail
FROM kernel_transitions kt
JOIN pipeline_runs pr ON pr.id = kt.entity_id
WHERE kt.entity = 'run'
  AND kt.actor_type = 'user';
