-- ISS-452 (ISS-442 C6 / invariant I7, amendment 1) — queryable interventions
-- metric. Hand-written migration (applied from meta/_journal.json).
--
-- One row per intervention-class event so VISION §1 metric ② (interventions
-- per issue closed) is CHARTABLE, not aspirational. Three sources:
--   - wedge          — a `pipeline_wedge` notification: the loop monitor (or a
--                      demoted sweeper alarm) surfaced a non-progressing hop.
--   - manual_cancel  — C0's audited single-job cancel escape hatch
--                      (job_events.kind = 'intervention').
--   - user_run_flip  — a HUMAN terminally flipping a pipeline_run through the
--                      C1 kernel chokepoint (kernel_transitions, entity='run',
--                      actor_type='user' — e.g. manual run cancel). Job-level
--                      user flips are excluded here because the C0 path
--                      already writes the job_events intervention row (no
--                      double count).
--
-- issue_id is NULL for project-scoped events (pm/system runs). Read via
-- GET /api/pipeline/interventions (pipeline/analytics-routes.ts), which
-- aggregates per issue. Idempotent (CREATE OR REPLACE).
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
  'manual_cancel'::text AS source,
  j.project_id          AS project_id,
  j.issue_id            AS issue_id,
  e.ts                  AS occurred_at,
  COALESCE(e.data->>'reason', 'manual job cancel') AS detail
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
