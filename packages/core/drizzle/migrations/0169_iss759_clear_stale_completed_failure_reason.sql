-- ISS-759 — ONE-SHOT backfill: clear `failure_reason` on agent_sessions that
-- ended `completed` but still carry the I1 trigger's stamp.
--
-- Mechanism (fixed in the same change, jobs/agent-session-link.ts): the I1
-- trigger from 0113/0118 stamps failure_reason='orphan_under_terminal_run' on an
-- ACTIVE session when its pipeline_run goes terminal. A late runner report then
-- lands in syncAgentSessionLifecycle, which flipped the row to `completed`
-- WITHOUT clearing the reason — leaving a row that is completed and failed at
-- once. 6 such rows observed on forge-dev over 7 days (2026-07-22 → 07-28), one
-- with 244 messages, so this is a steady recurrence rather than a one-off.
--
-- Scoped deliberately: only rows whose status is terminal-success AND whose
-- reason is the trigger's own literal. A `completed` row with any OTHER reason is
-- left alone — nothing here has verified those are stale, and silently widening
-- the predicate would be the same over-reach this issue is about.
--
-- Idempotent: re-running matches zero rows once applied.
UPDATE "agent_sessions"
SET "failure_reason" = NULL
WHERE "status" = 'completed'
  AND "failure_reason" = 'orphan_under_terminal_run';
