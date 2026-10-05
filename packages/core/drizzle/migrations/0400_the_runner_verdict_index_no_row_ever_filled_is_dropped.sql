-- ISS-219: phase_journal_runner_verdicts_idx indexed rows with source 'runner' and a 'verdict'
-- artifact, which nothing writes; the review-rejection alarm reads the reviewer's handoffs in
-- issue_step_contexts instead. The index is dropped with its last reader.
--
-- ROLLBACK: CREATE INDEX phase_journal_runner_verdicts_idx ON phase_journal (run_id, started_at)
-- WHERE source = 'runner' AND artifact ->> 'kind' = 'verdict';

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. The table this file touches is locked up front, before any statement holds a
-- lock a live session could be waiting behind; a table that stays busy past lock_timeout fails the
-- deploy loudly instead of deadlocking mid-file. A table this database never had is skipped.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['phase_journal'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(t));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "phase_journal_runner_verdicts_idx";
