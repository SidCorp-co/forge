-- Each issue's traced criteria, with the verdicts coverage reads of them, are kept per issue, so no
-- read assembles them again (ISS-1070 r7). Assembling them was the largest cost of a person's
-- attention read: for a person in twelve projects one statement answered 35,640 verdict rows (892 ms)
-- and turning them into criteria about as much again, of 2.7 s.
--
-- `issue_criteria_facts`: one row an issue, its criteria as `requirements/standing-facts.ts` reads
-- them (`StandingIssueCriterion[]`), written only by `requirements/criteria-facts.ts`, the model's
-- one owner, which computes it with the live read itself.
-- `issue_criteria_facts_stale`: the issues whose inputs moved since their facts were written. Each
-- input table's trigger marks the issue inside the writing transaction, whoever writes it, as 0627
-- does for the builder rule; the owner rewrites a marked issue's facts before any read serves them and
-- clears only the mark it read (`gen`), so a write racing it stays marked. An issue marked for its
-- builder facts (`issue_read_model_stale`, 0627) is read as owed too, since its verdicts' builder
-- flags are part of these facts. What marks an issue, each a superset of what the read reads:
--   criterion_verdicts       any insert, update or delete of the issue's verdicts;
--   verdict_builder_facts    any insert, update or delete of a builder flag (0627's owner writes it);
--   issue_criteria           any insert, update (the old and the new issue) or delete;
--   issue_design_criteria    any insert, update or delete: the class it gives a criterion;
--   requirement_criteria     an update or delete: every issue whose criteria trace it;
--   requirement_baselines    any insert, update or delete: every issue tracing that requirement,
--   requirement_baseline_pins  whose newest baseline pins a design or contract verdict;
--   project_workflows        a flow renamed or a workflow deleted: the issues with a verdict on it;
--   projects                 a slug changed: the issues with a contract verdict;
--   kernel_transitions       an issue's move into or out of `reopen`, and any update or delete;
--   issue_attachments        any insert, update or delete: the files a verdict's evidence names.
-- Every issue is marked here, and the owner fills them from the existing rows
-- (`boot-backfills.ts:startDeferredBackfills`, and any read before it).
--
-- ROLLBACK: DROP TRIGGER IF EXISTS forge_criteria_facts_verdicts_ins ON criterion_verdicts; DROP TRIGGER IF EXISTS forge_criteria_facts_verdicts_upd ON criterion_verdicts; DROP TRIGGER IF EXISTS forge_criteria_facts_verdicts_del ON criterion_verdicts; DROP TRIGGER IF EXISTS forge_criteria_facts_builder_ins ON verdict_builder_facts; DROP TRIGGER IF EXISTS forge_criteria_facts_builder_upd ON verdict_builder_facts; DROP TRIGGER IF EXISTS forge_criteria_facts_builder_del ON verdict_builder_facts; DROP TRIGGER IF EXISTS forge_criteria_facts_criteria_ins ON issue_criteria; DROP TRIGGER IF EXISTS forge_criteria_facts_criteria_upd ON issue_criteria; DROP TRIGGER IF EXISTS forge_criteria_facts_criteria_del ON issue_criteria; DROP TRIGGER IF EXISTS forge_criteria_facts_design ON issue_design_criteria; DROP TRIGGER IF EXISTS forge_criteria_facts_traced ON requirement_criteria; DROP TRIGGER IF EXISTS forge_criteria_facts_baselines ON requirement_baselines; DROP TRIGGER IF EXISTS forge_criteria_facts_pins ON requirement_baseline_pins; DROP TRIGGER IF EXISTS forge_criteria_facts_workflows ON project_workflows; DROP TRIGGER IF EXISTS forge_criteria_facts_workflows_del ON project_workflows; DROP TRIGGER IF EXISTS forge_criteria_facts_slugs ON projects; DROP TRIGGER IF EXISTS forge_criteria_facts_reopens ON kernel_transitions; DROP TRIGGER IF EXISTS forge_criteria_facts_transitions ON kernel_transitions; DROP TRIGGER IF EXISTS forge_criteria_facts_files ON issue_attachments; DROP FUNCTION IF EXISTS forge_criteria_facts_verdicts(), forge_criteria_facts_builder(), forge_criteria_facts_criteria(), forge_criteria_facts_design(), forge_criteria_facts_traced(), forge_criteria_facts_requirement(), forge_criteria_facts_workflow(), forge_criteria_facts_slug(), forge_criteria_facts_reopen(), forge_criteria_facts_file(), forge_issues_tracing_requirement(uuid), forge_mark_criteria_facts_stale(uuid[], text); DROP TABLE IF EXISTS issue_criteria_facts, issue_criteria_facts_stale;
CREATE TABLE IF NOT EXISTS "issue_criteria_facts" (
  "issue_id" uuid PRIMARY KEY REFERENCES "issues"("id") ON DELETE CASCADE,
  "criteria" jsonb NOT NULL,
  "computed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "issue_criteria_facts_array_chk" CHECK (jsonb_typeof("criteria") = 'array')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_criteria_facts_stale" (
  "issue_id" uuid PRIMARY KEY,
  "gen" bigint NOT NULL DEFAULT 1,
  "cause" text NOT NULL,
  "marked_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_criteria_facts_stale_marked_idx"
  ON "issue_criteria_facts_stale" ("marked_at", "issue_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_mark_criteria_facts_stale(ids uuid[], why text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO issue_criteria_facts_stale (issue_id, cause)
  SELECT x, why FROM (SELECT DISTINCT x FROM unnest(ids) AS u(x) WHERE x IS NOT NULL) d ORDER BY x
  ON CONFLICT (issue_id) DO UPDATE
    SET gen = issue_criteria_facts_stale.gen + 1, cause = EXCLUDED.cause, marked_at = now()
$$;
--> statement-breakpoint
-- the issues whose criteria trace a criterion of requirement `req`
CREATE OR REPLACE FUNCTION forge_issues_tracing_requirement(req uuid) RETURNS uuid[]
LANGUAGE sql STABLE AS $$
  SELECT coalesce(array_agg(DISTINCT c.issue_id), '{}') FROM issue_criteria c
    JOIN requirement_criteria rc ON rc.id = c.requirement_criterion_id
   WHERE rc.requirement_id = req
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_verdicts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY(SELECT DISTINCT o.issue_id FROM old_rows o), 'verdict');
  ELSE
    PERFORM forge_mark_criteria_facts_stale(ARRAY(SELECT DISTINCT n.issue_id FROM new_rows n), 'verdict');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_verdicts_ins AFTER INSERT ON criterion_verdicts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_verdicts();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_verdicts_upd AFTER UPDATE ON criterion_verdicts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_verdicts();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_verdicts_del AFTER DELETE ON criterion_verdicts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_verdicts();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_builder() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY(SELECT DISTINCT o.issue_id FROM old_rows o), 'builder');
  ELSE
    PERFORM forge_mark_criteria_facts_stale(ARRAY(SELECT DISTINCT n.issue_id FROM new_rows n), 'builder');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_builder_ins AFTER INSERT ON verdict_builder_facts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_builder();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_builder_upd AFTER UPDATE ON verdict_builder_facts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_builder();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_builder_del AFTER DELETE ON verdict_builder_facts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_builder();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_criteria() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY(SELECT DISTINCT o.issue_id FROM old_rows o), 'criterion');
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM forge_mark_criteria_facts_stale(
      ARRAY(SELECT o.issue_id FROM old_rows o UNION SELECT n.issue_id FROM new_rows n), 'criterion');
  ELSE
    PERFORM forge_mark_criteria_facts_stale(ARRAY(SELECT DISTINCT n.issue_id FROM new_rows n), 'criterion');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_criteria_ins AFTER INSERT ON issue_criteria
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_criteria();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_criteria_upd AFTER UPDATE ON issue_criteria
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_criteria();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_criteria_del AFTER DELETE ON issue_criteria
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION forge_criteria_facts_criteria();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_design() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY[NEW.issue_id], 'design_class');
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY[OLD.issue_id, NEW.issue_id], 'design_class');
  ELSE
    PERFORM forge_mark_criteria_facts_stale(ARRAY[OLD.issue_id], 'design_class');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_design AFTER INSERT OR UPDATE OR DELETE ON issue_design_criteria
  FOR EACH ROW EXECUTE FUNCTION forge_criteria_facts_design();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_traced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM forge_mark_criteria_facts_stale(
    ARRAY(SELECT c.issue_id FROM issue_criteria c WHERE c.requirement_criterion_id = OLD.id), 'traced');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_traced AFTER UPDATE OR DELETE ON requirement_criteria
  FOR EACH ROW EXECUTE FUNCTION forge_criteria_facts_traced();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_requirement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM forge_mark_criteria_facts_stale(forge_issues_tracing_requirement(OLD.requirement_id), 'baseline');
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM forge_mark_criteria_facts_stale(forge_issues_tracing_requirement(NEW.requirement_id), 'baseline');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_baselines AFTER INSERT OR UPDATE OR DELETE ON requirement_baselines
  FOR EACH ROW EXECUTE FUNCTION forge_criteria_facts_requirement();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_pins AFTER INSERT OR UPDATE OR DELETE ON requirement_baseline_pins
  FOR EACH ROW EXECUTE FUNCTION forge_criteria_facts_requirement();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_workflow() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM forge_mark_criteria_facts_stale(
    ARRAY(SELECT DISTINCT v.issue_id FROM criterion_verdicts v WHERE v.design_workflow_id = OLD.id),
    'workflow');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_workflows AFTER UPDATE ON project_workflows
  FOR EACH ROW WHEN (OLD.flow IS DISTINCT FROM NEW.flow OR OLD.id IS DISTINCT FROM NEW.id)
  EXECUTE FUNCTION forge_criteria_facts_workflow();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_workflows_del AFTER DELETE ON project_workflows
  FOR EACH ROW EXECUTE FUNCTION forge_criteria_facts_workflow();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_slug() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM forge_mark_criteria_facts_stale(
    ARRAY(SELECT DISTINCT v.issue_id FROM criterion_verdicts v WHERE v.contract_ref IS NOT NULL),
    'project_slug');
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_slugs AFTER UPDATE ON projects
  FOR EACH ROW WHEN (OLD.slug IS DISTINCT FROM NEW.slug)
  EXECUTE FUNCTION forge_criteria_facts_slug();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_reopen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.entity = 'issue' THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY[OLD.entity_id], 'reopen');
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.entity = 'issue' THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY[NEW.entity_id], 'reopen');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- a reopen, and the move that ends it (`issues/release-evidence.ts:reopenedAtRead`)
CREATE TRIGGER forge_criteria_facts_reopens AFTER INSERT ON kernel_transitions
  FOR EACH ROW WHEN (NEW.entity = 'issue' AND (NEW.to_status = 'reopen' OR NEW.from_status = 'reopen'))
  EXECUTE FUNCTION forge_criteria_facts_reopen();
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_transitions AFTER UPDATE OR DELETE ON kernel_transitions
  FOR EACH ROW EXECUTE FUNCTION forge_criteria_facts_reopen();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_criteria_facts_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY[OLD.issue_id], 'file');
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM forge_mark_criteria_facts_stale(ARRAY[NEW.issue_id], 'file');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER forge_criteria_facts_files AFTER INSERT OR UPDATE OR DELETE ON issue_attachments
  FOR EACH ROW EXECUTE FUNCTION forge_criteria_facts_file();
--> statement-breakpoint
INSERT INTO issue_criteria_facts_stale (issue_id, cause)
SELECT i.id, 'backfill' FROM issues i
ON CONFLICT (issue_id) DO NOTHING;
