-- ISS-1257 — a question dies with the work it asked about.
--
-- An open `agent_questions` row on an issue that already reached `closed` or
-- `dropped` asks a person for a decision nothing can act on: measured on
-- 2026-09-27, 21 of the 27 open questions across this box hung off terminal
-- issues, each presenting as a person's outstanding decision. From this change
-- on `issues/apply-transition.ts` refuses such a close by name; this is the
-- population that predates the refusal.
--
-- Each row is VOIDED, never deleted: its steps, prompt and any earlier round's
-- answer stay on it, and the reason names the status its issue had reached. A
-- question somebody answered is not open and is not touched. Reversal is by
-- `ended_by`:
--   UPDATE agent_questions SET status = 'open', void_reason = NULL,
--          ended_by = NULL, ended_reason = NULL, updated_at = now()
--    WHERE ended_by = 'migration:0311';
DO $$
DECLARE
  voided int;
BEGIN
  UPDATE agent_questions AS q
     SET status = 'void',
         void_reason = 'the issue reached `' || i.status || '` on '
           || to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
           || ' while this question was still open, so no answer to it can reach the work'
           || ' — voided by migration 0311 (ISS-1257)',
         ended_by = 'migration:0311',
         ended_reason = 'issue_terminal',
         updated_at = now()
    FROM issues AS i
   WHERE q.issue_id = i.id
     AND q.status = 'open'
     AND i.status IN ('closed', 'dropped');
  GET DIAGNOSTICS voided = ROW_COUNT;
  RAISE NOTICE '0311: voided % open question(s) standing on a closed or dropped issue', voided;
END $$;
