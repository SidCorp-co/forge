-- A question may name the project rule that asks for a person's act (ISS-869): such a question is
-- that person's on any gate profile, so an agent's ask of a person is admitted by the project's own
-- rule, and an agent's answer or void of it is refused. Null on every question written before.
--
-- ROLLBACK: ALTER TABLE "agent_questions" DROP COLUMN IF EXISTS "rule";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "rule" text;
