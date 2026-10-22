-- A steward decision about a stuck feedback item names that item in `about` (REQ-48 BC-5): a stuck
-- FB-n whose next act was a person's could get no question at all, since `feedback_id` is a
-- reporter's clarification (triage voids it, the reporter is shown it) and the steward's question is
-- a triager's or a member's to answer.
--   agent_questions.about   gains the shape {"kind":"feedback","feedbackId":"<uuid>"}. No row
--                           changes: every row already holds one of the two older shapes.
--
-- ROLLBACK: restore the check without the feedback shape, once no row holds it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_questions" DROP CONSTRAINT IF EXISTS "agent_questions_about_shape_chk";--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_about_shape_chk" CHECK ("about" is null or (
        ("about" ->> 'kind' = 'requirement' and jsonb_typeof("about" -> 'requirementId') = 'string')
        or ("about" ->> 'kind' = 'contract' and jsonb_typeof("about" -> 'contract') = 'string')
        or ("about" ->> 'kind' = 'feedback' and jsonb_typeof("about" -> 'feedbackId') = 'string')
      ));
