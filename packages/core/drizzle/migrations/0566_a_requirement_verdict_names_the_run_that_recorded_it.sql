-- A verdict at the requirement names the run session that recorded it, as a verdict on an issue
-- criterion has since 0528. The requirement verdict door refused a `run` (its body is strict), so a
-- judge declared over a requirement's issues recorded its business-criterion verdicts as nobody's
-- run: the box and the account were kept, the run was not. The write now records the session the
-- call's `run` names, resolved and refused by the same rule as an issue verdict's
-- (`issues/pattern-runs.ts:runOfCall`). Older rows hold none. No row changes.
--
-- ROLLBACK: drop the column; which run recorded a requirement verdict written since is lost.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" ADD COLUMN IF NOT EXISTS "run_session_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" DROP CONSTRAINT IF EXISTS "requirement_criterion_verdicts_run_session_id_agent_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "requirement_criterion_verdicts" ADD CONSTRAINT "requirement_criterion_verdicts_run_session_id_agent_sessions_id_fk" FOREIGN KEY ("run_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
