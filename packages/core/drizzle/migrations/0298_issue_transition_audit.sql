-- ISS-1107 — the fourth audited entity: `issues`.
--
-- The kernel audits its derivatives and not its source. `jobs`, `pipeline_runs`
-- and `agent_sessions` each carry a `trg_*_unaudited_transition` trigger, so a
-- status write that did not stamp `forge.kernel_txn` is charted in
-- `unaudited_transitions` and counted as a hand on the database. `issues` — the
-- Intent every one of those rows descends from — carried none of it, and the
-- question "who moved this issue out of `in_progress`, when, and under which
-- actor" terminated at a comment.
--
-- `issues/apply-transition.ts:transitionIssueStatus` now stamps the marker and
-- writes its own `kernel_transitions` row in the same transaction as the status
-- UPDATE; this migration adds the trigger that catches everything else.
--
-- Detection not prevention, unchanged from 0217 and 0219: manual SQL stays
-- legal, it is simply no longer silent. `issue_intervention_events` selects
-- `unaudited_transitions` wholesale, so these rows arrive on the existing
-- `direct_sql` arm with no change to the view.
--
-- The rule 0219 left for the next migration, restated here because the document
-- it pointed at has since been deleted: a migration that backfills `status` on
-- an audited table stamps the marker itself
-- (`SELECT set_config('forge.kernel_txn', txid_current()::text, true)` in the
-- same transaction), because nothing can tell a reviewed migration from a hand
-- at the console and excluding migrations by `application_name` would put a
-- spoofable hole in the instrument. This migration writes no status, so it
-- needs no such stamp.

-- ── The issue a flipped row belongs to, when the row IS the issue ────────────
-- `forge_unaudited_issue_id` resolves through `issue_id`, then the parent run,
-- then `metadata.issueId`. An `issues` row has none of the three: its own `id`
-- is the answer. The branch is made here, on the entity the trigger already
-- passes, rather than by giving that resolver a second signature — an overload
-- would leave two resolvers in the schema and no caller able to say which one
-- it got.
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
  USING TG_ARGV[0], NEW.id, NEW.project_id,
        CASE WHEN TG_ARGV[0] = 'issue' THEN NEW.id
             ELSE forge_unaudited_issue_id(to_jsonb(NEW)) END,
        OLD.status, NEW.status,
        current_user, nullif(current_setting('application_name', true), ''), inet_client_addr()::text;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- The deletion detector takes the same branch off OLD, so the two functions
-- cannot drift apart on how an entity resolves to its issue. No `issues`
-- deletion trigger is created here — `issues` is already a cascading parent
-- that stamps the marker before it deletes, and a deletion trigger on it is a
-- decision of its own.
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
  USING TG_ARGV[0], OLD.id, OLD.project_id,
        CASE WHEN TG_ARGV[0] = 'issue' THEN OLD.id
             ELSE forge_unaudited_issue_id(to_jsonb(OLD)) END,
        OLD.status, 'deleted',
        current_user, nullif(current_setting('application_name', true), ''), inet_client_addr()::text;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

-- ── The trigger ──────────────────────────────────────────────────────────────
-- `entity` reuses the `kernel_transitions` vocabulary, which now carries
-- 'issue'; the column is plain `text` with no CHECK, so the value needs no DDL
-- of its own.
DROP TRIGGER IF EXISTS trg_issues_unaudited_transition ON issues;--> statement-breakpoint
CREATE TRIGGER trg_issues_unaudited_transition
  AFTER UPDATE OF status ON issues
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION forge_detect_unaudited_transition('issue');
