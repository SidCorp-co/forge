-- ISS-352 — backfill: repaint sessions falsely marked failed by a SUCCESSFUL
-- pipeline close.
--
-- Root cause (fixed forward in runs-cascade.ts): when a terminal pipeline step
-- (forge-test → released, forge-release → closed) set its issue terminal as its
-- last action, the run closed `completed` and the cascade reaped the step's own
-- still-`running` session, stamping it `status='failed', failure_reason=
-- 'pipeline_completed'`. `pipeline_completed` is the cascade's SUCCESS sentinel,
-- never a real failure — so the exact `(failed, pipeline_completed)` pair is by
-- definition the false-positive set (ISS-351's forge-test / forge-release
-- sessions among them).
--
-- Forward-only code cannot repaint rows already stored, so this migration
-- corrects them to the clean terminal status the run actually reached.
-- Genuine failures carry other reasons (`job_failed`, `pipeline_failed`,
-- `pipeline_cancelled`, …) and are untouched. Idempotent — re-running matches
-- zero rows once repainted.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0087/0088/0089/0090 headers). The runtime migrator
-- applies this row from _journal.json.

UPDATE "agent_sessions"
   SET "status" = 'completed', "failure_reason" = NULL
 WHERE "status" = 'failed' AND "failure_reason" = 'pipeline_completed';
