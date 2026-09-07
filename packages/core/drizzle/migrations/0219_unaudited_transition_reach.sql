-- ISS-943 — the three classes 0217's detector could not see: `agent_sessions`,
-- every NON-terminal flip, and row deletion.
--
-- Each was left out of 0217 because widening the trigger ALONE would have
-- overcounted: the runner's `PATCH /:id` writes a session status directly, and
-- dispatch/claim/requeue/pause write a non-terminal status directly, so ordinary
-- traffic would have charted as manual SQL. What changed is not the test — it is
-- the set of writers that stamp `forge.kernel_txn`. `db/kernel-marker.ts`
-- carries `withKernelMarker`, every legitimate status writer and row deleter on
-- the three tables goes through it, and `kernel-marker-guard.test.ts` fails the
-- build on one that does not. With the stamp at every legitimate site, the
-- discriminator that was sound for two tables and one flip shape is sound for
-- three tables, any flip, and deletes.
--
-- Detection not prevention, unchanged: manual SQL stays legal.
-- `issue_intervention_events` is untouched — it selects `unaudited_transitions`
-- wholesale, so every row below arrives on the existing `direct_sql` arm.
-- The rule this leaves for the next migration is in docs/modules/control-observability/README.md.

-- ── The issue a flipped row belongs to ───────────────────────────────────────
-- `agent_sessions` has NO `issue_id` column (0217's function reads `NEW.issue_id`
-- directly, which is why it could not be pointed at that table without erroring
-- on every session write). A session reaches its issue through
-- `pipeline_run_id -> pipeline_runs.issue_id` for the pipeline lane and through
-- `metadata.issueId` for the chat/schedule lane, so resolve rather than record
-- NULL: an intervention the per-issue rollup cannot see is only half counted.
--
-- `jobs` gains the same fallback, which is a behaviour change on the arm 0217
-- shipped: a job whose own `issue_id` is NULL but which hangs off a run that has
-- one is now charged to that issue instead of to the project alone.
--
-- The uuid regex is not decoration. `metadata` is free-form jsonb written by
-- runners and by chat, so an `issueId` that is not a uuid is reachable, and a
-- failed cast inside this function would abort the operator's UPDATE — the
-- detector must never be able to refuse a write it exists only to count.
CREATE OR REPLACE FUNCTION forge_unaudited_issue_id(rec jsonb) RETURNS uuid AS $$
DECLARE
  resolved uuid;
  candidate text;
BEGIN
  IF rec->>'issue_id' IS NOT NULL THEN
    RETURN (rec->>'issue_id')::uuid;
  END IF;
  IF rec->>'pipeline_run_id' IS NOT NULL THEN
    SELECT issue_id INTO resolved FROM pipeline_runs WHERE id = (rec->>'pipeline_run_id')::uuid;
    IF resolved IS NOT NULL THEN
      RETURN resolved;
    END IF;
  END IF;
  candidate := rec#>>'{metadata,issueId}';
  IF candidate ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN candidate::uuid;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;--> statement-breakpoint

-- Replaces 0217's body: `NEW.issue_id` becomes the resolver above so the same
-- function can serve `agent_sessions`. Everything else is unchanged.
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
  USING TG_ARGV[0], NEW.id, NEW.project_id, forge_unaudited_issue_id(to_jsonb(NEW)),
        OLD.status, NEW.status,
        current_user, nullif(current_setting('application_name', true), ''), inet_client_addr()::text;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── Class 2: any status change, not only a terminal one ──────────────────────
-- Same trigger, same function; only the terminal `IN (...)` leaves the `WHEN`.
DROP TRIGGER IF EXISTS trg_jobs_unaudited_transition ON jobs;--> statement-breakpoint
CREATE TRIGGER trg_jobs_unaudited_transition
  AFTER UPDATE OF status ON jobs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION forge_detect_unaudited_transition('job');--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_pipeline_runs_unaudited_transition ON pipeline_runs;--> statement-breakpoint
CREATE TRIGGER trg_pipeline_runs_unaudited_transition
  AFTER UPDATE OF status ON pipeline_runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION forge_detect_unaudited_transition('run');--> statement-breakpoint

-- ── Class 1: `agent_sessions` ────────────────────────────────────────────────
-- `entity` reuses the `kernel_transitions` vocabulary, where a session is
-- already 'session'; no schema change is needed to hold these rows.
DROP TRIGGER IF EXISTS trg_agent_sessions_unaudited_transition ON agent_sessions;--> statement-breakpoint
CREATE TRIGGER trg_agent_sessions_unaudited_transition
  AFTER UPDATE OF status ON agent_sessions
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION forge_detect_unaudited_transition('session');--> statement-breakpoint

-- ── Class 3: row deletion ────────────────────────────────────────────────────
-- A DELETE has no NEW row, so `from_status` is the status the row held and
-- `to_status` is the sentinel 'deleted' — which reads correctly in the view's
-- detail line ("job running→deleted by postgres") and needs no new column.
--
-- `project_id` and `issue_id` come off OLD for the same reason 0217 took them
-- off NEW: the record of the intervention has to outlive the row, and after a
-- DELETE there is nothing left to join to.
--
-- FK cascade is why this is sound and not merely detectable: deleting a
-- `projects` row cascades all three tables and deleting an `issues` row
-- cascades `pipeline_runs`, but the cascade runs in the SAME transaction as the
-- parent DELETE, so the marker the parent stamped covers every child row it
-- takes with it.
CREATE OR REPLACE FUNCTION forge_detect_unaudited_deletion() RETURNS trigger AS $$
BEGIN
  IF current_setting('forge.kernel_txn', true) = txid_current()::text THEN
    RETURN NULL;
  END IF;
  EXECUTE format(
    'INSERT INTO %I.unaudited_transitions '
    '(entity, entity_id, project_id, issue_id, from_status, to_status, db_user, application_name, client_addr) '
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    TG_TABLE_SCHEMA)
  USING TG_ARGV[0], OLD.id, OLD.project_id, forge_unaudited_issue_id(to_jsonb(OLD)),
        OLD.status, 'deleted',
        current_user, nullif(current_setting('application_name', true), ''), inet_client_addr()::text;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_jobs_unaudited_deletion ON jobs;--> statement-breakpoint
CREATE TRIGGER trg_jobs_unaudited_deletion
  AFTER DELETE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION forge_detect_unaudited_deletion('job');--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_pipeline_runs_unaudited_deletion ON pipeline_runs;--> statement-breakpoint
CREATE TRIGGER trg_pipeline_runs_unaudited_deletion
  AFTER DELETE ON pipeline_runs
  FOR EACH ROW
  EXECUTE FUNCTION forge_detect_unaudited_deletion('run');--> statement-breakpoint

-- A cascade may already have removed the parent run by the time this fires, so
-- the resolver's middle branch can come back empty here where it would not on an
-- UPDATE. That is the `metadata.issueId` fallback's other reason to exist.
DROP TRIGGER IF EXISTS trg_agent_sessions_unaudited_deletion ON agent_sessions;--> statement-breakpoint
CREATE TRIGGER trg_agent_sessions_unaudited_deletion
  AFTER DELETE ON agent_sessions
  FOR EACH ROW
  EXECUTE FUNCTION forge_detect_unaudited_deletion('session');
