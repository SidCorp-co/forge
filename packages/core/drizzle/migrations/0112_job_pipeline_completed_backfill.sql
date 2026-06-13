-- ISS-447 (ISS-442 C1, amendment 2 / ISS-444) — backfill: repaint JOB rows that
-- a SUCCESSFUL pipeline close mislabeled as cancelled/failed.
--
-- Root cause (fixed forward in runs-cascade.ts): when a terminal pipeline step
-- (forge-test -> released, forge-release -> closed) set its issue terminal as
-- its last action, the run closed `completed` and the cascade reaped the step's
-- own still-active job, stamping it `status='cancelled', failure_reason=
-- 'pipeline_completed'`. `pipeline_completed` is the cascade's SUCCESS sentinel,
-- never a real failure — this mirrors the ISS-352 session backfill (0091) on the
-- JOB axis.
--
-- Unlike sessions, a job cancelled with `pipeline_completed` is NOT always a
-- success: a never-ran sibling job (e.g. a queued step) legitimately cancels
-- when the issue closes. So this is gated on positive completion evidence — a
-- terminal step-handoff row for the job's step on the same run — exactly the
-- signal finalize-done.ts trusts over the runner's exit detection. Genuine
-- never-ran siblings have no handoff and stay cancelled.
--
-- Idempotent — re-running matches zero rows once repainted. Hand-written; the
-- runtime migrator applies this from _journal.json.

UPDATE "jobs" AS j
   SET "status" = 'done',
       "exit_code" = 0,
       "error" = NULL,
       "failure_reason" = NULL,
       "failure_kind" = NULL
 WHERE j."status" IN ('cancelled', 'failed')
   AND j."failure_reason" = 'pipeline_completed'
   AND EXISTS (
     SELECT 1
       FROM "issue_step_contexts" c
      WHERE c."pipeline_run_id" = j."pipeline_run_id"
        AND c."kind" = 'handoff'
        AND c."step" = j."type"
   );
