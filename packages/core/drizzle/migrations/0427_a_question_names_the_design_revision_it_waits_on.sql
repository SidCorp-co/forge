-- A park question may name the workflow design revision it waits on, so the approver's decision on
-- that revision answers it and the issue moves on as an answer moves it (ISS-254). Before this a
-- question asking a person to approve a revision and the approval itself were two unrelated writes,
-- and the issue kept reading "waiting on you" after the revision was approved. Rows asked before it
-- name no revision and keep being answered by hand; nothing is inferred from their prompt.
--
-- Additive: two nullable columns, a both-or-neither check, a foreign key to the revision row and an
-- index on the open rows a decision looks up. No existing row is touched, and code without this
-- change neither reads nor writes the columns.
--
-- ROLLBACK: DROP INDEX IF EXISTS agent_questions_awaits_design_open_idx;
--           ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_awaits_design_fk;
--           ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_awaits_design_chk;
--           ALTER TABLE agent_questions DROP COLUMN IF EXISTS awaits_revision;
--           ALTER TABLE agent_questions DROP COLUMN IF EXISTS awaits_workflow_id;

ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "awaits_workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "awaits_revision" integer;--> statement-breakpoint
ALTER TABLE "agent_questions" DROP CONSTRAINT IF EXISTS "agent_questions_awaits_design_chk";--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_awaits_design_chk" CHECK (("agent_questions"."awaits_workflow_id" IS NULL) = ("agent_questions"."awaits_revision" IS NULL));--> statement-breakpoint
ALTER TABLE "agent_questions" DROP CONSTRAINT IF EXISTS "agent_questions_awaits_design_fk";--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_awaits_design_fk" FOREIGN KEY ("awaits_workflow_id", "awaits_revision") REFERENCES "public"."project_workflow_designs"("workflow_id", "revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_questions_awaits_design_open_idx" ON "agent_questions" USING btree ("awaits_workflow_id", "awaits_revision") WHERE "agent_questions"."status" = 'open' and "agent_questions"."awaits_workflow_id" is not null;
