-- A requirement holds every business question its revision leaves open, not one: the partial unique
-- index that let a requirement carry a single open question (the BA assistant's one-open-ask rule)
-- is dropped, and a plain index on requirement_id serves the requirement page's read instead. A
-- feedback item keeps its one open clarification (agent_questions_feedback_open_uq stays), and a
-- requirement keeps one open questionnaire batch (questionnaire_batches_open_requirement_uq stays).
--
-- `about` is what an asker named a question as about, a requirement or a contract, written by the
-- ask path and never read from prose. It is not requirement_id: that column moves the question to
-- the requirement's operational surface, and `about` leaves it where it was asked. Every existing
-- row reads null, which is what an ask naming nothing stores.
DROP INDEX IF EXISTS agent_questions_requirement_open_uq;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_questions_requirement_idx ON agent_questions (requirement_id) WHERE requirement_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE agent_questions ADD COLUMN IF NOT EXISTS about jsonb;
--> statement-breakpoint
ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_about_shape_chk;
--> statement-breakpoint
ALTER TABLE agent_questions ADD CONSTRAINT agent_questions_about_shape_chk CHECK (about IS NULL OR (
  (about ->> 'kind' = 'requirement' AND jsonb_typeof(about -> 'requirementId') = 'string')
  OR (about ->> 'kind' = 'contract' AND jsonb_typeof(about -> 'contract') = 'string')
));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_questions_about_requirement_idx ON agent_questions ((about ->> 'requirementId')) WHERE about ->> 'kind' = 'requirement';
