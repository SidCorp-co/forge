-- ISS-996 — every stored round gains the answer-shape tag it was written without.
--
-- A choice was the only shape a round could have before this, so every existing
-- step is a choice one. The tag is stamped rather than defaulted at read time so
-- the untagged arm of `isChoiceStep` drains instead of living forever.
UPDATE agent_questions
SET steps = (
  SELECT jsonb_agg(
    CASE
      WHEN step ? 'answerShape' THEN step
      ELSE step || '{"answerShape":"choice"}'::jsonb
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(steps) WITH ORDINALITY AS t(step, ord)
)
WHERE jsonb_typeof(steps) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(steps) AS s(step)
    WHERE NOT (s.step ? 'answerShape')
  );
