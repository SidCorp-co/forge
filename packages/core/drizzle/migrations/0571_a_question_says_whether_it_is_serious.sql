-- A question carries whether its asker judged it serious (REQ-79 BC-13, BC-14, ISS-845): irreversible,
-- real money, credentials or product direction. A decision is owed to a person only on a strict
-- project and only where it is serious; every other is the project's master's or agent's. Every
-- existing row was asked before the asker said, so it reads not serious; its blocker kind stays as
-- it was written.
--
-- ROLLBACK: drop the column; every question then reads by its blocker kind alone.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "serious" boolean DEFAULT false NOT NULL;
