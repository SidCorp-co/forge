-- ISS-884 — count the interventions that never touched the audited path.
--
-- The north-star is interventions per issue closed, and until now the ruler was
-- three arms of `issue_intervention_events`, every one of which only sees a flip
-- that some TypeScript wrote. A `psql` `UPDATE jobs SET status='cancelled'` —
-- the way a wedged fleet actually gets unstuck — wrote none of them, so the
-- number fell while reality did not.
--
-- Detection, not prevention. Manual SQL stays legal: the operator is not
-- refused, blocked or slowed. The flip simply stops being invisible.
--
-- Why the absence of a marker is a sound test, and only on these two tables:
-- `lifecycle/transition.ts:applyKernelTransition` is the sole in-code writer of
-- a TERMINAL status on `jobs` and `pipeline_runs` — `transition-guard.test.ts`
-- fails the build on a second one — and it stamps `forge.kernel_txn` with its
-- own txid inside the same transaction as the UPDATE. So on those two tables an
-- unmarked terminal flip has exactly one explanation. Every other candidate
-- would overcount: `agent_sessions` has legitimate direct writers (the runner's
-- own `PATCH /:id` writes a variable status), and non-terminal writes (dispatch,
-- claim, requeue, pause) are ordinary code that stamps nothing.

CREATE TABLE IF NOT EXISTS "unaudited_transitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "issue_id" uuid,
  "from_status" text,
  "to_status" text NOT NULL,
  "db_user" text NOT NULL,
  "application_name" text,
  "client_addr" text,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "unaudited_transitions_project_idx" ON "unaudited_transitions" ("project_id","detected_at");--> statement-breakpoint

-- No FK to jobs/pipeline_runs on purpose: a hand that flips a row by SQL may
-- delete it by SQL next, and the record of the intervention must outlive the
-- row it was performed on. Same reason `kernel_transitions.actor_id` is a bare
-- uuid.
CREATE OR REPLACE FUNCTION forge_detect_unaudited_transition() RETURNS trigger AS $$
BEGIN
  IF current_setting('forge.kernel_txn', true) = txid_current()::text THEN
    RETURN NULL;
  END IF;
  EXECUTE format(
    'INSERT INTO %I.unaudited_transitions '
    '(entity, entity_id, project_id, issue_id, from_status, to_status, db_user, application_name, client_addr) '
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    TG_TABLE_SCHEMA)
  USING TG_ARGV[0], NEW.id, NEW.project_id, NEW.issue_id, OLD.status, NEW.status,
        current_user, nullif(current_setting('application_name', true), ''), inet_client_addr()::text;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_jobs_unaudited_transition ON jobs;--> statement-breakpoint
CREATE TRIGGER trg_jobs_unaudited_transition
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('done','failed','cancelled'))
  EXECUTE FUNCTION forge_detect_unaudited_transition('job');--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_pipeline_runs_unaudited_transition ON pipeline_runs;--> statement-breakpoint
CREATE TRIGGER trg_pipeline_runs_unaudited_transition
  AFTER UPDATE OF status ON pipeline_runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed','failed','cancelled'))
  EXECUTE FUNCTION forge_detect_unaudited_transition('run');--> statement-breakpoint

-- The fourth arm. The other three are unchanged from 0181.
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
  AND kt.actor_type = 'user'
UNION ALL
SELECT
  'direct_sql'::text    AS source,
  u.project_id          AS project_id,
  u.issue_id            AS issue_id,
  u.detected_at         AS occurred_at,
  concat(u.entity, ' ', COALESCE(u.from_status, '?'), '→', u.to_status, ' by ', u.db_user,
         COALESCE(' [' || u.application_name || ']', '')) AS detail
FROM unaudited_transitions u;
