-- A park question may name the issue whose merge mark it waits on, so the stamp that writes the mark
-- answers it and the issue moves on as an answer moves it. Found live on 2026-10-08: epod ISS-5, ISS-6
-- and catalog-fe ISS-8 sat at `needs_info` for about a day on questions whose only condition was "when
-- the landing mark appears", after 0450 had stamped the marks; nothing read the condition. Rows asked
-- before this name no issue and keep being answered by hand: nothing is inferred from their prompt.
--
-- Additive: one nullable column referencing the awaited issue, a check that a question waits on one
-- fact (a design decision or a merge mark, never both), and an index on the open rows a stamp looks up.
--
-- BACKFILL. `forge_answer_marked_questions` answers every open question whose awaited issue already
-- carries its mark, as `questions/merge-wait.ts:answerMergeQuestions` answers one at the stamp: the
-- free-text round answered with a sentence naming the mark (commit or landing, and when), the move
-- recorded in `kernel_transitions` under the question machine, the answer recorded on the issue, and
-- each one named in a NOTICE. A migration reaches no in-process consumer, so it does not return the
-- park: the NOTICE names each issue still parked, for its master to move. Idempotent: an answered row
-- is not open, so a second run answers nothing. A later migration that stamps marks in SQL (0450's
-- shape) calls the function after its stamp. The column is born here, so this run answers none.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS forge_answer_marked_questions(text);
--           DROP INDEX IF EXISTS agent_questions_awaits_merge_open_idx;
--           ALTER TABLE agent_questions DROP CONSTRAINT IF EXISTS agent_questions_awaits_one_chk;
--           ALTER TABLE agent_questions DROP COLUMN IF EXISTS awaits_merge_issue_id;

ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "awaits_merge_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_questions" DROP CONSTRAINT IF EXISTS "agent_questions_awaits_merge_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_awaits_merge_issue_id_issues_id_fk" FOREIGN KEY ("awaits_merge_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_questions" DROP CONSTRAINT IF EXISTS "agent_questions_awaits_one_chk";--> statement-breakpoint
ALTER TABLE "agent_questions" ADD CONSTRAINT "agent_questions_awaits_one_chk" CHECK ("agent_questions"."awaits_workflow_id" IS NULL OR "agent_questions"."awaits_merge_issue_id" IS NULL);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_questions_awaits_merge_open_idx" ON "agent_questions" USING btree ("awaits_merge_issue_id") WHERE "agent_questions"."status" = 'open' and "agent_questions"."awaits_merge_issue_id" is not null;--> statement-breakpoint

CREATE OR REPLACE FUNCTION forge_answer_marked_questions(p_reason text) RETURNS integer AS $$
DECLARE
  prior text := current_setting('forge.kernel_txn', true);
  n integer;
  listed text;
BEGIN
  CREATE TEMP TABLE marked_question ON COMMIT DROP AS
  SELECT q.id, q.project_id, q.issue_id, q.steps, coalesce(p.issue_prefix, 'ISS') || '-' || a.iss_seq AS awaited_key,
         a.merged_at, a.merged_commit_sha, a.merged_landing, p.created_by,
         wp.slug, coalesce(wp.issue_prefix, 'ISS') || '-' || w.iss_seq AS parked_key, w.status AS parked_status,
         format('The merge mark of %s was recorded: %s at %s.',
                coalesce(p.issue_prefix, 'ISS') || '-' || a.iss_seq,
                CASE
                  WHEN coalesce(trim(a.merged_commit_sha), '') <> '' THEN 'commit ' || a.merged_commit_sha
                  WHEN coalesce(trim(a.merged_landing), '') <> '' THEN 'landing ' || a.merged_landing
                  ELSE 'a mark naming no commit and no landing'
                END,
                to_char(a.merged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS answer
    FROM agent_questions q
    JOIN issues a ON a.id = q.awaits_merge_issue_id
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN issues w ON w.id = q.issue_id
    LEFT JOIN projects wp ON wp.id = w.project_id
   WHERE q.status = 'open' AND a.merged_at IS NOT NULL
     FOR UPDATE OF q;

  PERFORM set_config('forge.kernel_txn', txid_current()::text, true);
  UPDATE agent_questions q
     SET status = 'answered',
         steps = jsonb_set(q.steps, ARRAY[(jsonb_array_length(q.steps) - 1)::text],
                   (q.steps -> -1) || jsonb_build_object(
                     'answeredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                     'answerText', m.answer,
                     'answeredBy', m.created_by::text)),
         updated_at = now()
    FROM marked_question m
   WHERE q.id = m.id AND q.status = 'open';
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO kernel_transitions
    (entity, entity_id, from_status, to_status, machine_version, reason, actor_type, actor_agency, actor_id, source)
  SELECT 'question', id, 'open', 'answered', 1, p_reason, 'user', 'agent', created_by, 'migration'
    FROM marked_question;
  PERFORM set_config('forge.kernel_txn', coalesce(prior, ''), true);

  INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload)
  SELECT issue_id, 'user', created_by, 'agent', 'record.answer',
         jsonb_build_object('contract', 1, 'lead', NULL, 'fields', jsonb_build_array(
           jsonb_build_object('key', 'question', 'value', id::text),
           jsonb_build_object('key', 'round', 'value', (steps -> -1 ->> 'round')),
           jsonb_build_object('key', 'answer', 'value', answer)))
    FROM marked_question WHERE issue_id IS NOT NULL;

  SELECT string_agg(format('question %s, awaiting %s (%s)', id, awaited_key,
           CASE WHEN issue_id IS NULL THEN 'on no issue'
                ELSE format('%s %s, now `%s`', slug, parked_key, parked_status) END), '; ' ORDER BY awaited_key, id)
    INTO listed FROM marked_question;
  RAISE NOTICE 'forge_answer_marked_questions (%): answered %: %', p_reason, n, coalesce(listed, 'none');
  SELECT string_agg(format('%s %s (%s)', slug, parked_key, issue_id), '; ' ORDER BY slug, parked_key)
    INTO listed FROM marked_question WHERE parked_status = 'needs_info';
  IF listed IS NOT NULL THEN
    RAISE NOTICE 'forge_answer_marked_questions (%): still parked, a migration returns no park — move each from the answered question: %', p_reason, listed;
  END IF;
  DROP TABLE marked_question;
  RETURN n;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

SELECT forge_answer_marked_questions('0453: the awaited merge mark already stands');
