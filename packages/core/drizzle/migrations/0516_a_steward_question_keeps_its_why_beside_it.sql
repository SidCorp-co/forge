-- A steward decision keeps the reason for its recommendation beside its question, not inside it
-- (REQ-48 r3 BC-14): the question is one plain sentence its options make, and the reason is the
-- round's own `why`, drawn once. Rounds asked before this wrote the reason into the prompt as
-- "... Recommended: <label>, because <why>", which the Approvals panel then cut out of the text on
-- every read. This carries it into `why` once, so the panel reads structured fields only.
--   agent_questions.steps   the last round of each steward decision (every option a `steward.*`
--                           id) without a `why` gains `why`: the words after ", because " following
--                           the prompt's last "Recommended: ". A round whose prompt holds neither
--                           marker is left without one and reads "The steward recorded no reason".
--
-- ROLLBACK: none needed; `why` is read where present and nothing else reads it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
UPDATE "agent_questions" q
   SET "steps" = jsonb_set(
         q."steps",
         ARRAY[(jsonb_array_length(q."steps") - 1)::text, 'why'],
         to_jsonb(left(btrim(substr(t.tail, strpos(t.tail, ', because ') + length(', because '))), 600))
       )
  FROM (
    SELECT id,
           right(steps -> -1 ->> 'prompt',
                 strpos(reverse(steps -> -1 ->> 'prompt'), reverse('Recommended: ')) - 1) AS tail
      FROM "agent_questions"
     WHERE jsonb_typeof(steps) = 'array'
       AND jsonb_array_length(steps) > 0
       AND steps -> -1 -> 'options' -> 0 ->> 'id' LIKE 'steward.%'
       AND strpos(steps -> -1 ->> 'prompt', 'Recommended: ') > 0
  ) t
 WHERE t.id = q.id
   AND NOT ((q."steps" -> -1) ? 'why')
   AND strpos(t.tail, ', because ') > 0
   AND btrim(substr(t.tail, strpos(t.tail, ', because ') + length(', because '))) <> '';
