-- A lesson about an agent's judgement or a Forge step (a process lesson) is routed to Forge as its
-- feedback, never drafted as an "Add a check" code issue in the project's backlog (ISS-1136: 29 such
-- drafts were dropped on 2026-11-08). The routed item is kept on the lesson, as the check issue is, so
-- a lesson is routed once.
--
-- ROLLBACK: ALTER TABLE "lessons" DROP COLUMN "routed_feedback_id";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "lessons" ADD COLUMN "routed_feedback_id" uuid REFERENCES "feedback"("id") ON DELETE SET NULL;
