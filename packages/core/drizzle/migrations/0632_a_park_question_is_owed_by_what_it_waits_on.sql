-- ISS-1127 — a park's question is owed by what the park waits on (`issues/park-owed.ts:parkOwedBy`).
-- Every park question was opened `human`, so a park on a resource or on another issue sat in the
-- owner's Needs you though no person owed an act (epod ISS-63, parked at `needs_resource` on forge
-- ISS-1125). New parks are minted right; this corrects the open ones, once, by the same rule:
--   - one waiting on its own issue's merge mark is `machine`: the mark answers it;
--   - one on an issue parked at `needs_info` with `needs_resource` is `master_or_peer`;
--   - one whose `needed` names another issue's key, in a prefix its project answers to, is
--     `master_or_peer`.
-- A park question is an open free-text question on an issue that nobody asked through a door
-- (`asked_by` null), no design revision answers, and no comment minted (a comment's question keeps
-- the comment's id). Each row moved is named in a NOTICE. A row is placed by its merge wait before
-- its words, so a mark's park with no `needed` is still `machine`; one with no `needed` and nothing
-- else to read it by (a park from before `needed` existed) stays `human`, as it is today and as a
-- person can answer it, and a NOTICE names it as left. Nothing here aborts a deploy.
--
-- ROLLBACK: none needed for the schema; the rows' old kind is `human`, and each NOTICE names a row.

DO $$
DECLARE
  r record;
  moved integer := 0;
BEGIN
  CREATE TEMP TABLE park_owed_1127 ON COMMIT DROP AS
  SELECT q.id, q.project_id, i.iss_seq,
         coalesce(p.issue_prefix, 'ISS') || '-' || i.iss_seq AS issue_key,
         i.status AS issue_status, i.waiting_kind,
         q.awaits_merge_issue_id IS NOT NULL AS awaits_merge,
         q.steps -> 0 ->> 'needed' AS needed,
         ARRAY(
           SELECT DISTINCT prefix FROM (
             SELECT 'ISS' AS prefix
             UNION SELECT p.issue_prefix WHERE p.issue_prefix IS NOT NULL
             UNION SELECT a.prefix FROM issue_prefix_aliases a WHERE a.project_id = q.project_id
           ) known
         ) AS prefixes
    FROM agent_questions q
    JOIN issues i ON i.id = q.issue_id
    JOIN projects p ON p.id = q.project_id
   WHERE q.status = 'open'
     AND q.blocker_kind = 'human'
     AND q.asked_by IS NULL
     AND q.requirement_id IS NULL AND q.feedback_id IS NULL AND q.batch_id IS NULL
     AND q.awaits_workflow_id IS NULL
     AND q.steps -> 0 ->> 'answerShape' = 'free_text'
     AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.id = q.id);

  FOR r IN
    SELECT k.id, k.issue_key,
           CASE
             WHEN k.awaits_merge THEN 'machine'
             WHEN k.issue_status = 'needs_info' AND k.waiting_kind = 'needs_resource' THEN 'master_or_peer'
             WHEN named.keys IS NOT NULL THEN 'master_or_peer'
           END AS kind,
           coalesce(btrim(k.needed), '') = '' AS mute,
           CASE
             WHEN k.awaits_merge THEN 'its own merge mark answers it'
             WHEN k.issue_status = 'needs_info' AND k.waiting_kind = 'needs_resource' THEN 'it waits on a resource'
             ELSE 'it waits on ' || named.keys
           END AS why
      FROM park_owed_1127 k
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT m[1] || '-' || m[2], ', ') AS keys
          FROM regexp_matches(
                 k.needed,
                 '\m(' || array_to_string(k.prefixes, '|') || ')-([1-9][0-9]{0,9})\M',
                 'g'
               ) AS m
         WHERE m[2]::bigint <> k.iss_seq
      ) named ON true
     ORDER BY k.id
  LOOP
    IF r.kind IS NULL THEN
      IF r.mute THEN
        RAISE NOTICE '0632: park question % on % left human: nothing says what settles it (no `needed`, no merge wait)', r.id, r.issue_key;
      END IF;
      CONTINUE;
    END IF;
    UPDATE agent_questions SET blocker_kind = r.kind, updated_at = now() WHERE id = r.id;
    moved := moved + 1;
    RAISE NOTICE '0632: park question % on % moved from human to %: %', r.id, r.issue_key, r.kind, r.why;
  END LOOP;
  RAISE NOTICE '0632: % park question(s) moved off a person', moved;
END $$;
