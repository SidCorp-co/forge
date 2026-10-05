-- ISS-219: phase_journal_runner_verdicts_idx indexed rows with source 'runner' and a 'verdict'
-- artifact, which nothing writes; the review-rejection alarm reads the reviewer's handoffs in
-- issue_step_contexts instead. The index is dropped with its last reader.
--
-- ROLLBACK: CREATE INDEX phase_journal_runner_verdicts_idx ON phase_journal (run_id, started_at)
-- WHERE source = 'runner' AND artifact ->> 'kind' = 'verdict';
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DROP INDEX IF EXISTS "phase_journal_runner_verdicts_idx";
