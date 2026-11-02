-- No count holds the questions an agent asks (ISS-904; owner, 2026-11-02: "Bỏ giới hạn đi"; REQ-66 r3
-- BC-4, REQ-10 r7 BC-6 and BC-7, REQ-65 r3 BC-3). A feedback item may hold several open
-- clarifications, so the partial unique index that kept one open per item goes. Onboarding asks the
-- rounds it needs, so the checks that capped a series at three rounds keep only their lower bound, and
-- an intake draft's answer may name any question it asked, not only the first three.
--
-- No row is rewritten: every existing row already satisfies the looser checks. ROLLBACK: recreate the
-- index and the BETWEEN checks from 0352, 0353 and 0533, which fails
-- while an item holds two open clarifications, a series has passed its third round or an answer names
-- a fourth question.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DROP INDEX IF EXISTS "agent_questions_feedback_open_uq";--> statement-breakpoint
ALTER TABLE "onboardings" DROP CONSTRAINT IF EXISTS "onboardings_rounds_chk";--> statement-breakpoint
ALTER TABLE "onboardings" ADD CONSTRAINT "onboardings_rounds_chk" CHECK ("rounds_sent" >= 0);--> statement-breakpoint
ALTER TABLE "questionnaire_batches" DROP CONSTRAINT IF EXISTS "questionnaire_batches_round_chk";--> statement-breakpoint
ALTER TABLE "questionnaire_batches" ADD CONSTRAINT "questionnaire_batches_round_chk" CHECK ("round" >= 1);--> statement-breakpoint
ALTER TABLE "intake_answers" DROP CONSTRAINT IF EXISTS "intake_answers_question_chk";--> statement-breakpoint
ALTER TABLE "intake_answers" ADD CONSTRAINT "intake_answers_question_chk" CHECK ("question" >= 1);
