-- ISS-904 (criterion 1, reopened on 0.4.0-dev.706). An agent asks the questions it needs, in as
-- many cards as it needs (owner 2026-11-02, "lift the limits"): a second questionnaire card on a
-- thread or a requirement while one is open stands beside it, no longer refused
-- QUESTIONNAIRE_ALREADY_OPEN.
--   1. questionnaire_batches_open_conversation_uq and questionnaire_batches_open_requirement_uq, the
--      partial unique indexes that held one open (or skipped) card per thread and per requirement,
--      are dropped.
--   2. questionnaire_batches_conversation_idx (conversation_id, status) takes over the reads of a
--      thread's cards the conversation index served.
-- No row changes.
--
-- ROLLBACK (refused while any thread or requirement holds two answerable cards):
--   DROP INDEX IF EXISTS "questionnaire_batches_conversation_idx";
--   CREATE UNIQUE INDEX "questionnaire_batches_open_conversation_uq" ON "questionnaire_batches" USING btree ("conversation_id") WHERE status IN ('open', 'skipped');
--   CREATE UNIQUE INDEX "questionnaire_batches_open_requirement_uq" ON "questionnaire_batches" USING btree ("requirement_id") WHERE status IN ('open', 'skipped') AND requirement_id IS NOT NULL;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DROP INDEX IF EXISTS "questionnaire_batches_open_conversation_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "questionnaire_batches_open_requirement_uq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questionnaire_batches_conversation_idx" ON "questionnaire_batches" USING btree ("conversation_id","status");
