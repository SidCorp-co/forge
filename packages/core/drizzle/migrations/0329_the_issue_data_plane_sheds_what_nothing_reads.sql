-- ISS-1132 — the issue data plane sheds the tables and the column nothing reads, and keeps the
-- one promise `issue_attributes` made and never held.
--
-- WHAT GOES, with the counts read on beta (database `forge`, read-only, 2026-10-14):
--   tasks                       359 rows over 156 issues, newest 2026-08-22. 0 carry an assignee, 0 an
--                               order, 0 an agent status or log; 354 carry a priority other than
--                               'none'. Task priority is a feature this migration withdraws: no
--                               other store holds a per-subtask priority.
--   issue_attribute_defs        10 rows, the registry's own keys. The code registry is the only
--                               authority; the table existed to carry one foreign key.
--   issue_step_contexts.verdict 3236 values (1504 review, 1732 test), newest 2026-08-31. The same
--                               verdict stays in each row's `payload`; only the typed copy goes, with
--                               `pass_rate` and `approve_rate`, the two metrics that read it.
--   attribute keys `blocking` and `supersedes`: 0 rows. Whether an issue blocks is `issue_dependencies`.
--
-- WHAT COMES IN: a partial unique index over (issue_id, key) for the single-row keys. Before it, a
-- single-row key was kept single by delete-then-insert, which two concurrent writers both pass.
--
-- THE GUARD aborts the deploy naming the row, and never cleans a row away so the DDL succeeds:
-- a task holding an assignee or an order (a feature with no home once the table is gone), a
-- single-row key already holding two rows for one issue (the state the index exists to forbid, and
-- picking a winner here would choose for a person), and a row of a retired attribute key.
DO $$
DECLARE
  bad record;
  n_tasks int;
  n_priority int;
  n_verdicts int;
BEGIN
  SELECT id, issue_id, assignee_id, sort_order INTO bad
    FROM tasks WHERE assignee_id IS NOT NULL OR sort_order <> 0
    ORDER BY created_at, id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ISS-1132: task % on issue % holds an assignee (%) or an order (%), a withdrawn feature with no store to move to. Nothing was changed; read the task and decide before this migration runs.',
      bad.id, bad.issue_id, bad.assignee_id, bad.sort_order;
  END IF;

  SELECT issue_id, key, count(*) AS n INTO bad
    FROM issue_attributes
    WHERE key IN ('obligation_owner', 'obligation_carrier', 'delivered', 'delivered_of', 'human_required', 'irreversible_if_wrong', 'source')
    GROUP BY issue_id, key HAVING count(*) > 1
    ORDER BY issue_id, key LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ISS-1132: issue % holds % rows of the single-row attribute key %. Nothing was changed; keep the one that is true and delete the rest before this migration runs.',
      bad.issue_id, bad.n, bad.key;
  END IF;

  SELECT id, issue_id, key INTO bad FROM issue_attributes WHERE key IN ('blocking', 'supersedes') ORDER BY id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ISS-1132: attribute row % on issue % holds the retired key %. Nothing was changed; a blocking relation is an issue_dependencies edge, so move it there or drop the row before this migration runs.',
      bad.id, bad.issue_id, bad.key;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE priority <> 'none') INTO n_tasks, n_priority FROM tasks;
  SELECT count(verdict) INTO n_verdicts FROM issue_step_contexts;
  RAISE NOTICE 'ISS-1132: dropping % tasks (of which % carried a priority, a withdrawn feature) and % typed step verdicts, each verdict kept in its payload', n_tasks, n_priority, n_verdicts;
END $$;
--> statement-breakpoint
DROP TABLE "tasks" CASCADE;--> statement-breakpoint
ALTER TABLE "issue_attributes" DROP CONSTRAINT "issue_attributes_key_issue_attribute_defs_key_fk";--> statement-breakpoint
DROP TABLE "issue_attribute_defs" CASCADE;--> statement-breakpoint
DROP INDEX "issue_step_contexts_verdict_idx";--> statement-breakpoint
ALTER TABLE "issue_step_contexts" DROP COLUMN "verdict";--> statement-breakpoint
CREATE UNIQUE INDEX "issue_attributes_single_row_uq" ON "issue_attributes" USING btree ("issue_id","key") WHERE "issue_attributes"."key" IN ('obligation_owner', 'obligation_carrier', 'delivered', 'delivered_of', 'human_required', 'irreversible_if_wrong', 'source');
