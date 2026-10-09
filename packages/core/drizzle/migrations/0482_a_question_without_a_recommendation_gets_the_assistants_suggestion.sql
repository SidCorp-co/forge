-- A person question that came with no recommended answer gets one the assistant drafts off the read
-- path (REQ-41 BC-2, ISS-495): `suggestion` holds, for the round it was drafted for, either the
-- suggested text with its one-line why and the records it read, or the named code it could not be
-- drafted under. The asker's own recommendation stays on the round's step and always wins.
--
-- ROLLBACK: DROP COLUMN suggestion (nothing else reads it; the card falls back to "no recommended
-- answer").
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "suggestion" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_questions" DROP CONSTRAINT IF EXISTS "agent_questions_suggestion_shape_chk";
--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_suggestion_shape_chk" CHECK ("agent_questions"."suggestion" IS NULL OR (jsonb_typeof("agent_questions"."suggestion") = 'object' AND "agent_questions"."suggestion" ->> 'outcome' IN ('suggested', 'failed') AND jsonb_typeof("agent_questions"."suggestion" -> 'round') = 'number'));
