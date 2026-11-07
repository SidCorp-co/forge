-- ISS-1084 — a question a steward check asked before ISS-688 is asked again as the question it was.
-- Until ISS-688 (2026-11-01) the intake and breakdown checks asked by posting a question comment on
-- the requirement, and the delivery gate refused `REQUIREMENT_QUESTION_OPEN` naming
-- `/questions/<comment id>`: a door that answers 404, since a comment is no question row, and no
-- door answered it (adminhub-api REQ-8, sidcorp-mail REQ-6; forge REQ-80 holds two). ISS-688 priced
-- reading those comments as open questions until each was answered by a reply or its requirement
-- ended (`requirements/delivery-check.ts`, `steward/holds.ts`); this ends that amnesty.
--
-- Each such comment still open (no reply from anyone but its author, its act not undone, its
-- requirement not ended) becomes a question row under the SAME id, so the id every refusal and read
-- already named reads at `questions/:id`, is listed on its requirement and is answered at
-- `questions/:id/answer`. It is asked as `door-ask.ts` asks today: about the requirement, owed by
-- the project's master (`master_or_peer`), asked by the steward account that wrote the comment, at
-- the comment's time. Its options were written as prose (`<prompt>\n\nOptions: <id>: <label>; …. Recommended:
-- <id>.`), and a label may itself hold "; ", so they are not split into choices: the round is free
-- text, its prompt the comment's first paragraph, `needed` the options as written, and `recommended`
-- the option id the steward named. A comment answered by a reply is left as it is: it holds nothing.
--
-- Rows are only inserted, never edited or deleted; a row already there under that id is kept.
--
-- ROLLBACK: DELETE FROM "agent_questions" q USING "comments" c WHERE q."id" = c."id" AND q."status" = 'open';

INSERT INTO "agent_questions"
  ("id", "project_id", "asked_by", "status", "blocker_kind", "steps", "about", "created_at", "updated_at")
SELECT c."id", r."project_id", c."author_id", 'open', 'master_or_peer',
       jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
         'round', 1,
         'answerShape', 'free_text',
         'prompt', btrim(split_part(c."body", E'\n\nOptions: ', 1)),
         'needed', CASE
           WHEN strpos(c."body", E'\n\nOptions: ') > 0
             THEN btrim(substr(c."body", strpos(c."body", E'\n\nOptions: ') + 2))
           ELSE 'The answer, in your own words.'
         END,
         'recommended', substring(c."body" from 'Recommended: (\S+)\.\s*$'),
         'askedAt', to_char(c."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       ))),
       jsonb_build_object('kind', 'requirement', 'requirementId', r."id"::text),
       c."created_at", now()
  FROM "steward_acts" a
  JOIN "comments" c ON c."id"::text = a."wrote" ->> 'ref'
  JOIN "requirements" r ON r."id" = c."requirement_id" AND r."project_id" = a."project_id"
 WHERE a."act" IN ('intake_check', 'breakdown_check')
   AND a."wrote" ->> 'kind' = 'comment'
   AND a."undone_at" IS NULL
   AND c."intent" = 'question'
   AND r."status" IN ('agreed', 'in_delivery', 'delivered', 'deferred')
   AND NOT EXISTS (
     SELECT 1 FROM "comments" reply
      WHERE reply."parent_id" = c."id" AND reply."author_id" <> c."author_id")
ON CONFLICT ("id") DO NOTHING;
