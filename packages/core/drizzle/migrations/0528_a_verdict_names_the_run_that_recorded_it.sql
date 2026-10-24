-- A verdict names the run session that recorded it (ISS-475, REQ-36 BC-16, REQ-74 BC-2). Who built
-- an issue was read off the box a verdict came from: any session holding the issue's lease there was
-- "the builder", so a judge run declared over an awaiting_release issue on the builder's box had its
-- own verdicts read as the builder's and never counted under independent QA. The write now records
-- the session it resolves (the `run` the call names, else the session holding the issue's lease on
-- the caller's box), and `issues/built-by.ts` reads that session alone. Older rows hold none and keep
-- the box reading. No row changes.
--
-- ROLLBACK: drop the column; every verdict is then read off its box again, and which run recorded a
-- verdict written since is lost.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "run_session_id" uuid;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_run_session_id_agent_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_run_session_id_agent_sessions_id_fk" FOREIGN KEY ("run_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
