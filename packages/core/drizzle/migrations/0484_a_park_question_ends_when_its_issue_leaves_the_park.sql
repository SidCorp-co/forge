-- REQ-41 BC-11 (QA of 0.4.0-dev.220): a park's question ends in the move that takes its issue out of
-- the park. From this change on `issues/apply-transition.ts` withdraws it in that move's own
-- transaction (`questions/issue-coupling.ts:withdrawParkQuestions`); this is the population that
-- predates the rule. Found live: ISS-439 was parked at `needs_info` by the rescue cap on 2026-10-08,
-- moved back to `open` by a person without an answer, and its question went on saying "Decision
-- waiting - Person" on the issue page, the project home and in chat after the issue reached
-- `awaiting_release`. The boot re-home (`issues/rescue-cap-rehome.ts`) reads only issues still AT
-- `needs_info`, so it never saw it.
--
-- A park's question is the open person question written in the park's own transaction: its
-- `created_at` equals that of the issue's `kernel_transitions` move into `needs_info`. It is stale
-- when the issue has a recorded move out of `needs_info` after that entry and no longer stands at
-- `needs_info`. A question anybody else asked is not touched. An issue parked at `needs_info` AGAIN
-- keeps the old question open: a park that finds a person already owing an answer mints none and
-- waits on that one (`issues/park-question.ts:mintParkQuestion`), so it is that park's wait now;
-- a second NOTICE names each such row for its master (dev: ISS-299).
--
-- Each row is VOIDED (Withdrawn), never deleted: its prompt and steps stay, the reason names the
-- status the issue left the park for, when, and the mover's own reason; the move is recorded in
-- `kernel_transitions` under the question machine. A RAISE NOTICE names every row changed.
-- Idempotent: a voided row is not open, so a second run changes nothing.
--
-- ROLLBACK (by `ended_by`):
--   UPDATE agent_questions SET status = 'open', void_reason = NULL, ended_by = NULL,
--          ended_reason = NULL, updated_at = now() WHERE ended_by = 'migration:0484';
--   (run with forge.kernel_txn set to txid_current(), as below)
DO $$
DECLARE
  prior text := current_setting('forge.kernel_txn', true);
  n integer;
  listed text;
BEGIN
  CREATE TEMP TABLE left_park_question ON COMMIT DROP AS
  SELECT DISTINCT ON (q.id)
         q.id, p.slug, coalesce(p.issue_prefix, 'ISS') || '-' || i.iss_seq AS issue_key,
         i.status AS issue_status, i.status = 'needs_info' AS parked_again,
         format('the issue left `needs_info` for `%s` on %s without this being answered, so the park that asked it no longer waits on a person%s (withdrawn by migration 0484, REQ-41 BC-11)',
                x.to_status,
                to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
                CASE WHEN coalesce(trim(x.reason), '') = '' THEN '' ELSE ': ' || trim(x.reason) END) AS why
    FROM agent_questions q
    JOIN issues i ON i.id = q.issue_id
    JOIN projects p ON p.id = i.project_id
    JOIN kernel_transitions k
      ON k.entity = 'issue' AND k.entity_id = q.issue_id
     AND k.to_status = 'needs_info' AND k.created_at = q.created_at
    JOIN LATERAL (
      SELECT e.to_status, e.reason, e.created_at FROM kernel_transitions e
       WHERE e.entity = 'issue' AND e.entity_id = q.issue_id
         AND e.from_status = 'needs_info' AND e.created_at > k.created_at
       ORDER BY e.created_at, e.id LIMIT 1
    ) x ON true
   WHERE q.status = 'open' AND q.blocker_kind = 'human'
   ORDER BY q.id;

  PERFORM set_config('forge.kernel_txn', txid_current()::text, true);
  UPDATE agent_questions q
     SET status = 'void',
         void_reason = l.why,
         ended_by = 'migration:0484',
         ended_reason = 'park_left',
         updated_at = now()
    FROM left_park_question l
   WHERE q.id = l.id AND q.status = 'open' AND NOT l.parked_again;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO kernel_transitions
    (entity, entity_id, from_status, to_status, machine_version, reason, actor_type, actor_agency, actor_id, source)
  SELECT 'question', id, 'open', 'void', 1, why, 'system', 'agent', NULL, 'migration'
    FROM left_park_question WHERE NOT parked_again;
  PERFORM set_config('forge.kernel_txn', coalesce(prior, ''), true);

  SELECT string_agg(format('question %s on %s %s (issue now `%s`)', id, slug, issue_key, issue_status), '; '
           ORDER BY slug, issue_key, id)
    INTO listed FROM left_park_question WHERE NOT parked_again;
  RAISE NOTICE '0484: withdrew % park question(s) whose issue left the park: %', n, coalesce(listed, 'none');
  SELECT string_agg(format('question %s on %s %s', id, slug, issue_key), '; ' ORDER BY slug, issue_key, id)
    INTO listed FROM left_park_question WHERE parked_again;
  IF listed IS NOT NULL THEN
    RAISE NOTICE '0484: left open, the issue is parked at needs_info again and its park waits on this question; its master answers or withdraws it: %', listed;
  END IF;
  DROP TABLE left_park_question;
END $$;
