-- Whether each verdict is its issue's builder's is kept beside it, so no read computes the builder
-- rule (`issues/built-by.ts`) again (ISS-1070 r5). The rule read every verdict against its issue's
-- check runs, run sessions, leases, landing and reopens, and Postgres planned that statement afresh
-- each time: about 1.9 s summed across a person in 12 projects, on every attention read.
--
-- `verdict_builder_facts`: one row a verdict, written only by `issues/builder-facts.ts`, the model's
-- one owner, which computes it with the rule itself.
-- `issue_read_model_stale`: the issues whose builder inputs moved since their facts were written.
-- Each input table's trigger marks the issue inside the writing transaction, whoever writes it, the
-- way 0070's trigger is the outbox's sole producer; the owner rewrites a marked issue's facts before
-- any read serves them and clears only the mark it read (`gen`), so a write racing it stays marked.
-- What marks an issue, each a superset of what the rule reads of that table:
--   criterion_verdicts   any insert, update (a deleted session nulls `run_session_id`) or delete;
--   issue_check_runs     insert or delete (an update is refused by 0476's guard);
--   issue_leases         insert, update or delete, by (project_id, issue_key);
--   pipeline_runs        a run whose group, opened statuses, role, project or birth moved, every key
--                        of its group before and after;
--   agent_sessions       a session whose run, kind, box, birth or status moved, or a terminal one
--                        whose `updated_at` moved; and its delete: every issue it is a candidate for;
--   issues               a landing (merged_at, sha, paths, artifacts), its key or its project;
--   kernel_transitions   an issue's move into `reopen`;
--   issue_criteria       a criterion moved to another issue (the amnesty reads a fail through it).
-- Every issue that holds a verdict is marked here, and the owner fills them from the existing rows
-- (`boot-backfills.ts:startDeferredBackfills`, and any read before it).
--
-- ROLLBACK: DROP TRIGGER IF EXISTS forge_builder_inputs_verdicts_ins ON criterion_verdicts; DROP TRIGGER IF EXISTS forge_builder_inputs_verdicts_upd ON criterion_verdicts; DROP TRIGGER IF EXISTS forge_builder_inputs_verdicts_del ON criterion_verdicts; DROP TRIGGER IF EXISTS forge_builder_inputs_checks_ins ON issue_check_runs; DROP TRIGGER IF EXISTS forge_builder_inputs_checks_del ON issue_check_runs; DROP TRIGGER IF EXISTS forge_builder_inputs_leases ON issue_leases; DROP TRIGGER IF EXISTS forge_builder_inputs_runs_ins ON pipeline_runs; DROP TRIGGER IF EXISTS forge_builder_inputs_runs_upd ON pipeline_runs; DROP TRIGGER IF EXISTS forge_builder_inputs_sessions_ins ON agent_sessions; DROP TRIGGER IF EXISTS forge_builder_inputs_sessions_upd ON agent_sessions; DROP TRIGGER IF EXISTS forge_builder_inputs_sessions_del ON agent_sessions; DROP TRIGGER IF EXISTS forge_builder_inputs_issues ON issues; DROP TRIGGER IF EXISTS forge_builder_inputs_reopens ON kernel_transitions; DROP TRIGGER IF EXISTS forge_builder_inputs_criteria ON issue_criteria; DROP FUNCTION IF EXISTS forge_builder_inputs_verdicts(), forge_builder_inputs_checks(), forge_builder_inputs_leases(), forge_builder_inputs_runs(), forge_builder_inputs_sessions(), forge_builder_inputs_issue(), forge_builder_inputs_reopen(), forge_builder_inputs_criterion(), forge_issues_of_run(uuid), forge_issues_of_keys(uuid, jsonb), forge_mark_issues_stale(uuid[], text); DROP TABLE IF EXISTS verdict_builder_facts, issue_read_model_stale;
CREATE TABLE IF NOT EXISTS "verdict_builder_facts" (
  "verdict_id" uuid PRIMARY KEY REFERENCES "criterion_verdicts"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "by_builder" boolean NOT NULL,
  "declared_before_landing" text,
  "computed_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verdict_builder_facts_issue_idx" ON "verdict_builder_facts" ("issue_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_read_model_stale" (
  "issue_id" uuid PRIMARY KEY,
  "gen" bigint NOT NULL DEFAULT 1,
  "cause" text NOT NULL,
  "marked_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_mark_issues_stale(ids uuid[], why text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO issue_read_model_stale (issue_id, cause)
  SELECT x, why FROM (SELECT DISTINCT x FROM unnest(ids) AS u(x) WHERE x IS NOT NULL) d ORDER BY x
  ON CONFLICT (issue_id) DO UPDATE
    SET gen = issue_read_model_stale.gen + 1, cause = EXCLUDED.cause, marked_at = now()
$$;
--> statement-breakpoint
-- the issues a run group names, as `built-by.ts:builderCandidatesAcrossSql` spells a group out
CREATE OR REPLACE FUNCTION forge_issues_of_keys(project uuid, grp jsonb) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(i.id), '{}') FROM issues i
   WHERE i.project_id = project
     AND ('ISS-' || i.iss_seq) IN (
       SELECT jsonb_array_elements_text(grp) WHERE jsonb_typeof(grp) = 'array'
       UNION ALL SELECT jsonb_object_keys(grp) WHERE jsonb_typeof(grp) = 'object'
       UNION ALL SELECT grp #>> '{}' WHERE jsonb_typeof(grp) = 'string')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_issues_of_run(run uuid) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT forge_issues_of_keys(r.project_id, r.metadata -> 'runGroup')
                     FROM pipeline_runs r WHERE r.id = run), '{}')
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_builder_inputs_verdicts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM forge_mark_issues_stale(ARRAY(SELECT DISTINCT o.issue_id FROM old_rows o), 'verdict');
  ELSE
    PERFORM forge_mark_issues_stale(ARRAY(SELECT DISTINCT n.issue_id FROM new_rows n), 'verdict');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_verdicts_ins AFTER INSERT ON criterion_verdicts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_builder_inputs_verdicts();
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_verdicts_upd AFTER UPDATE ON criterion_verdicts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_builder_inputs_verdicts();
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_verdicts_del AFTER DELETE ON criterion_verdicts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_builder_inputs_verdicts();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_builder_inputs_checks() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM forge_mark_issues_stale(ARRAY(SELECT DISTINCT o.issue_id FROM old_rows o), 'check_run');
  ELSE
    PERFORM forge_mark_issues_stale(ARRAY(SELECT DISTINCT n.issue_id FROM new_rows n), 'check_run');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_checks_ins AFTER INSERT ON issue_check_runs
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_builder_inputs_checks();
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_checks_del AFTER DELETE ON issue_check_runs
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_builder_inputs_checks();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_builder_inputs_leases() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM forge_mark_issues_stale(forge_issues_of_keys(OLD.project_id, to_jsonb(OLD.issue_key)), 'lease');
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM forge_mark_issues_stale(forge_issues_of_keys(NEW.project_id, to_jsonb(NEW.issue_key)), 'lease');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_leases AFTER INSERT OR UPDATE OR DELETE ON issue_leases
  FOR EACH ROW EXECUTE FUNCTION forge_builder_inputs_leases();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_builder_inputs_runs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    PERFORM forge_mark_issues_stale(forge_issues_of_keys(OLD.project_id, OLD.metadata -> 'runGroup'), 'run');
  END IF;
  PERFORM forge_mark_issues_stale(forge_issues_of_keys(NEW.project_id, NEW.metadata -> 'runGroup'), 'run');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_runs_ins AFTER INSERT ON pipeline_runs
  FOR EACH ROW WHEN (NEW.metadata ? 'runGroup')
  EXECUTE FUNCTION forge_builder_inputs_runs();
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_runs_upd AFTER UPDATE ON pipeline_runs
  FOR EACH ROW WHEN (
    (OLD.metadata ? 'runGroup' OR NEW.metadata ? 'runGroup') AND (
      OLD.metadata -> 'runGroup' IS DISTINCT FROM NEW.metadata -> 'runGroup'
      OR OLD.metadata -> 'runIssueStatuses' IS DISTINCT FROM NEW.metadata -> 'runIssueStatuses'
      OR OLD.metadata -> 'role' IS DISTINCT FROM NEW.metadata -> 'role'
      OR OLD.project_id IS DISTINCT FROM NEW.project_id
      OR OLD.created_at IS DISTINCT FROM NEW.created_at))
  EXECUTE FUNCTION forge_builder_inputs_runs();
--> statement-breakpoint
-- every issue a session is a builder candidate of (`built-by.ts:builderCandidatesSql`): a check it
-- recorded, its run's group, a lease it holds
CREATE OR REPLACE FUNCTION forge_builder_inputs_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s agent_sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN s := OLD; ELSE s := NEW; END IF;
  PERFORM forge_mark_issues_stale(
    ARRAY(SELECT k.issue_id FROM issue_check_runs k WHERE k.run_session_id = s.id)
    || forge_issues_of_run(s.pipeline_run_id)
    || ARRAY(SELECT x FROM issue_leases l,
               unnest(forge_issues_of_keys(l.project_id, to_jsonb(l.issue_key))) AS u(x)
              WHERE l.session_id = s.id),
    'session');
  IF TG_OP = 'UPDATE' AND OLD.pipeline_run_id IS DISTINCT FROM NEW.pipeline_run_id THEN
    PERFORM forge_mark_issues_stale(forge_issues_of_run(OLD.pipeline_run_id), 'session');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_sessions_ins AFTER INSERT ON agent_sessions
  FOR EACH ROW WHEN (NEW.pipeline_run_id IS NOT NULL)
  EXECUTE FUNCTION forge_builder_inputs_sessions();
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_sessions_upd AFTER UPDATE ON agent_sessions
  FOR EACH ROW WHEN (
    OLD.pipeline_run_id IS DISTINCT FROM NEW.pipeline_run_id
    OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.device_id IS DISTINCT FROM NEW.device_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.status IS DISTINCT FROM NEW.status
    OR (OLD.updated_at IS DISTINCT FROM NEW.updated_at
        AND NEW.status IN ('completed', 'failed', 'completed_via_recovery', 'cancelled_stale', 'cancelled')))
  EXECUTE FUNCTION forge_builder_inputs_sessions();
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_sessions_del AFTER DELETE ON agent_sessions
  FOR EACH ROW EXECUTE FUNCTION forge_builder_inputs_sessions();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_builder_inputs_issue() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM forge_mark_issues_stale(ARRAY[NEW.id], 'issue');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_issues AFTER UPDATE ON issues
  FOR EACH ROW WHEN (
    OLD.merged_at IS DISTINCT FROM NEW.merged_at
    OR OLD.merged_commit_sha IS DISTINCT FROM NEW.merged_commit_sha
    OR OLD.merged_paths IS DISTINCT FROM NEW.merged_paths
    OR OLD.merged_artifacts IS DISTINCT FROM NEW.merged_artifacts
    OR OLD.iss_seq IS DISTINCT FROM NEW.iss_seq
    OR OLD.project_id IS DISTINCT FROM NEW.project_id)
  EXECUTE FUNCTION forge_builder_inputs_issue();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_builder_inputs_reopen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM forge_mark_issues_stale(ARRAY[NEW.entity_id], 'reopen');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_reopens AFTER INSERT OR UPDATE ON kernel_transitions
  FOR EACH ROW WHEN (NEW.entity = 'issue' AND NEW.to_status = 'reopen')
  EXECUTE FUNCTION forge_builder_inputs_reopen();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_builder_inputs_criterion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM forge_mark_issues_stale(ARRAY[OLD.issue_id, NEW.issue_id], 'criterion');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_builder_inputs_criteria AFTER UPDATE ON issue_criteria
  FOR EACH ROW WHEN (OLD.issue_id IS DISTINCT FROM NEW.issue_id)
  EXECUTE FUNCTION forge_builder_inputs_criterion();
--> statement-breakpoint
INSERT INTO issue_read_model_stale (issue_id, cause)
SELECT DISTINCT v.issue_id, 'backfill' FROM criterion_verdicts v
ON CONFLICT (issue_id) DO NOTHING;
