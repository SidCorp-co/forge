-- ISS-1228 r20 — the master's ruling: a question raised by a job that works an issue is that issue's
-- question. jobs/blocked.ts now writes it there; before, every pool job's question was written at
-- project level (issue_id NULL), so the issue page showed nothing of it and the stalled-issue sweeps,
-- reading no open question on the issue, moved it back to Open as "nothing working".
--
-- Each such question already standing is linked to the issue of the job that asked it. That job is
-- found by the question's id, which jobs/blocked.ts derives from the job's id and the question's
-- place in its dialog (questions/pane-question-id.ts questionIdFor: the first 16 bytes of
-- sha1('forge:blocked-question:<job id>:<index>') stamped as a version-5 uuid), the one record both
-- rows hold. Only a job that stopped on a question and carries an issue in the question's own project
-- counts; an open question is not linked to an issue that has since closed or been dropped, which a
-- new ask is refused for too (questions/write.ts refuseFinishedWork) and so stays the project's.
--
-- Rollback: the rows linked here are not told apart from those written linked; leaving them linked
-- is the state the code now writes.
UPDATE agent_questions q
   SET issue_id = asked.issue_id
  FROM (
    SELECT j.issue_id,
           j.project_id,
           encode(
             set_byte(
               set_byte(h.head, 6, (get_byte(h.head, 6) & 15) | 80),
               8,
               (get_byte(h.head, 8) & 63) | 128
             ),
             'hex'
           )::uuid AS question_id
      FROM jobs j
     CROSS JOIN generate_series(0, 31) AS n(i)
     CROSS JOIN LATERAL (
       SELECT substring(digest('forge:blocked-question:' || j.id::text || ':' || n.i, 'sha1') FROM 1 FOR 16) AS head
     ) h
     WHERE j.failure_reason = 'stopped_on_question'
       AND j.issue_id IS NOT NULL
  ) asked
  JOIN issues i ON i.id = asked.issue_id
 WHERE q.id = asked.question_id
   AND q.issue_id IS NULL
   AND q.project_id = asked.project_id
   AND i.project_id = q.project_id
   AND (q.status <> 'open' OR i.status NOT IN ('closed', 'dropped'));
