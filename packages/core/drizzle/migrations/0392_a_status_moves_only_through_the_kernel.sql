-- ISS-189: every machine's status column is written only by the kernel transition, and every move
-- records the version of the machine that judged it.
--
-- `kernel_transitions.machine_version` is `StatusMachine.version` (`@forge/contracts/state-machine`);
-- a row recorded before machines were versioned keeps NULL, since nothing recorded which shape
-- judged it.
--
-- `forge_kernel_status_guard` refuses an UPDATE that changes a machine's status unless
-- `forge.kernel_txn` holds the current transaction id. The kernel transition sets it for its own
-- status write only (`db/kernel-marker.ts:asKernelStatusWrite`); a deleter that cascades into a
-- status (`forge_session_delete_settles_its_fire`) runs under `withKernelMarker`. This replaces
-- detection with prevention: the four `trg_*_unaudited_transition` detectors could only chart a
-- write that now never lands, so they and their function are dropped. The deletion detectors stay.
--
-- `forge_guard_status_column` installs the guard on one column; a migration that adds a machine
-- calls it for that machine's column. `forge_migrate_state_rows` is the declared migration for a
-- state or an edge a new machine version removes: it moves every row standing at a state, each move
-- recorded in `kernel_transitions` under the new version, or, given no target, aborts naming them.

ALTER TABLE "kernel_transitions" ADD COLUMN IF NOT EXISTS "machine_version" integer;--> statement-breakpoint

CREATE OR REPLACE FUNCTION forge_kernel_status_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('forge.kernel_txn', true) = txid_current()::text THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'KERNEL_STATUS_WRITE_REFUSED: % % `%` -> `%` (%.%) was written outside the kernel transition',
      TG_ARGV[0], NEW.id, to_jsonb(OLD) ->> TG_ARGV[1], to_jsonb(NEW) ->> TG_ARGV[1], TG_TABLE_NAME, TG_ARGV[1]
    USING HINT = 'A status moves only through packages/core/src/lifecycle/transition.ts:transition. A migration that moves rows calls forge_migrate_state_rows.';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION forge_guard_status_column(p_table regclass, p_column text, p_entity text)
RETURNS void AS $$
DECLARE
  trg text := format('trg_%s_%s_kernel_only', (SELECT relname FROM pg_class WHERE oid = p_table), p_column);
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trg, p_table);
  EXECUTE format(
    'CREATE TRIGGER %I BEFORE UPDATE OF %I ON %s FOR EACH ROW '
    'WHEN (OLD.%I IS DISTINCT FROM NEW.%I) EXECUTE FUNCTION forge_kernel_status_guard(%L, %L)',
    trg, p_column, p_table, p_column, p_column, p_entity, p_column);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION forge_migrate_state_rows(
  p_entity text,
  p_table regclass,
  p_column text,
  p_from text,
  p_to text,
  p_machine_version integer,
  p_reason text
) RETURNS integer AS $$
DECLARE
  n integer;
  named text;
  prior text := current_setting('forge.kernel_txn', true);
BEGIN
  IF p_to IS NULL THEN
    EXECUTE format(
      'SELECT count(*)::int, string_agg(id::text, '', '') FILTER (WHERE k <= 20) '
      'FROM (SELECT id, row_number() OVER (ORDER BY id) AS k FROM %s WHERE %I = $1) s',
      p_table, p_column)
      INTO n, named USING p_from;
    IF n > 0 THEN
      RAISE EXCEPTION 'MACHINE_ROWS_UNMIGRATED: % row(s) of % stand at `%` (%.%), which machine version % no longer allows them to rest at or leave; first: %. Name the state they move to.',
        n, p_entity, p_from, p_table, p_column, p_machine_version, named;
    END IF;
    RETURN 0;
  END IF;
  PERFORM set_config('forge.kernel_txn', txid_current()::text, true);
  EXECUTE format(
    'WITH moved AS (UPDATE %s SET %I = $2 WHERE %I = $1 RETURNING id) '
    'INSERT INTO kernel_transitions '
    '(entity, entity_id, from_status, to_status, machine_version, reason, actor_type, actor_agency, source) '
    'SELECT $3, id, $1, $2, $4, $5, ''system'', ''agent'', ''migration'' FROM moved',
    p_table, p_column, p_column)
    USING p_from, p_to, p_entity, p_machine_version, p_reason;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('forge.kernel_txn', coalesce(prior, ''), true);
  RETURN n;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

SELECT forge_guard_status_column('issues', 'status', 'issue');--> statement-breakpoint
SELECT forge_guard_status_column('jobs', 'status', 'job');--> statement-breakpoint
SELECT forge_guard_status_column('agent_sessions', 'status', 'session');--> statement-breakpoint
SELECT forge_guard_status_column('pipeline_runs', 'status', 'run');--> statement-breakpoint
SELECT forge_guard_status_column('suggestions', 'status', 'suggestion');--> statement-breakpoint
SELECT forge_guard_status_column('feedback', 'status', 'feedback');--> statement-breakpoint
SELECT forge_guard_status_column('requirements', 'status', 'requirement');--> statement-breakpoint
SELECT forge_guard_status_column('mockups', 'status', 'mockup');--> statement-breakpoint
SELECT forge_guard_status_column('questionnaire_batches', 'status', 'questionnaire');--> statement-breakpoint
SELECT forge_guard_status_column('agent_questions', 'status', 'question');--> statement-breakpoint
SELECT forge_guard_status_column('schedule_runs', 'status', 'schedule_run');--> statement-breakpoint
SELECT forge_guard_status_column('reconcile_runs', 'status', 'reconcile_run');--> statement-breakpoint
SELECT forge_guard_status_column('runners', 'status', 'runner');--> statement-breakpoint
SELECT forge_guard_status_column('runners', 'provision_status', 'runner_provision');--> statement-breakpoint
SELECT forge_guard_status_column('devices', 'status', 'device');--> statement-breakpoint
SELECT forge_guard_status_column('rocketchat_comment_mirrors', 'status', 'comment_mirror');--> statement-breakpoint
SELECT forge_guard_status_column('rocketchat_question_deliveries', 'status', 'question_delivery');--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_issues_unaudited_transition ON issues;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_jobs_unaudited_transition ON jobs;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_agent_sessions_unaudited_transition ON agent_sessions;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_pipeline_runs_unaudited_transition ON pipeline_runs;--> statement-breakpoint
DROP FUNCTION IF EXISTS forge_detect_unaudited_transition();
