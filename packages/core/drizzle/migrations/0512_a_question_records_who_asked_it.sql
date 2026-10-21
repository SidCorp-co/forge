-- A question records the account that asked it through its own door (REQ-48 BC-12): the steward's
-- questions on ISS-134 named no asker, so the item's activity could not say the Steward asked them.
--   agent_questions.asked_by   the user (a person, an agent token's account, the Steward) whose
--                              `POST /api/questions` wrote it. Null where the system asked (a sweep,
--                              a run's park) and on every question asked before this column: no older
--                              row names its asker, so none is guessed.
--
-- ROLLBACK: ALTER TABLE agent_questions DROP COLUMN asked_by.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "asked_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" DROP CONSTRAINT IF EXISTS "agent_questions_asked_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_asked_by_users_id_fk" FOREIGN KEY ("asked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
