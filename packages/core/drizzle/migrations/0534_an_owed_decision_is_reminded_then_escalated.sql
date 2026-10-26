-- An owed decision is reminded on day 3 and escalated on day 14 (ISS-686, REQ-68 BC-8).
--
-- agent_questions.reminded_at: when the people who owe the current round were reminded.
-- agent_questions.escalated_at: when the agent proposed deferring or dropping the requirement the
-- round holds up.
-- Each stamp counts only for the round asked before it, so a new round starts its own clock with no
-- reset. Rows written before this hold NULL for both. The first sweep reminds every round already 3
-- days old, once, and escalates those already 14 days old. Nothing is backfilled.
--
-- ROLLBACK: drop agent_questions.escalated_at and .reminded_at. The next sweep after the code is
-- reverted reminds nobody, and the record of who was reminded is lost.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp with time zone;
