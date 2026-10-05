-- Cleanup, audit 4: three things with no reader leave the schema.
--   issues.planned_baseline_seq: the plan flag reads traced BCs only since iss-w2-reqs, so the column
--     was written and read nowhere.
--   ws_publish_failed / ws-publish-failed: nothing has written either spelling since ISS-219, and the
--     read-time alias (contracts failure-causes.ts:LEGACY_CAUSE_ALIAS) that folded them into
--     dispatch_failed is deleted, so the stored rows are rewritten to dispatch_failed here.
--   retrieval_analytics: one row per memory search holding the raw query text, never scrubbed and read
--     by nothing; it goes with its writer and its retention sweep.
--
-- ROLLBACK: none for the contents. planned_baseline_seq and retrieval_analytics are deleted with their
-- rows; a rewritten cause reads as it already did through the alias. Undoing it means restoring from a
-- backup taken before it ran.
--
-- A legacy spelling in any reason or cause column other than the two rewritten here aborts this
-- migration naming the table and column: the rewrite only knows the session and job failure causes,
-- and once the alias is gone such a row would read unclassified with nobody told.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so every table this file writes is
-- locked up front in one fixed order (alphabetical); a table busy past lock_timeout fails the deploy
-- loudly. The two rewritten tables take only the row-write lock an UPDATE needs.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE "agent_sessions" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "issues" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "jobs" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('retrieval_analytics') IS NOT NULL THEN
    LOCK TABLE retrieval_analytics IN ACCESS EXCLUSIVE MODE;
  END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE col record; found_n bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.data_type IN ('text', 'character varying')
      AND (c.column_name ILIKE '%reason%' OR c.column_name ILIKE '%cause%')
      AND (c.table_name, c.column_name) NOT IN (('agent_sessions', 'failure_reason'), ('jobs', 'failure_reason'))
    ORDER BY c.table_name, c.column_name
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I IN (''ws_publish_failed'', ''ws-publish-failed'')', col.table_name, col.column_name) INTO found_n;
    IF found_n > 0 THEN
      RAISE EXCEPTION 'LEGACY_CAUSE_UNMAPPED: %.% holds % row(s) reading ws_publish_failed or ws-publish-failed; this migration rewrites that cause only in agent_sessions.failure_reason and jobs.failure_reason, and with the read-time alias deleted those rows would read unclassified, so it writes nothing until they are repaired', col.table_name, col.column_name, found_n USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
UPDATE "agent_sessions" SET "failure_reason" = 'dispatch_failed' WHERE "failure_reason" IN ('ws_publish_failed', 'ws-publish-failed');--> statement-breakpoint
UPDATE "jobs" SET "failure_reason" = 'dispatch_failed' WHERE "failure_reason" IN ('ws_publish_failed', 'ws-publish-failed');--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_planned_baseline_chk";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN IF EXISTS "planned_baseline_seq";--> statement-breakpoint
DROP TABLE IF EXISTS "retrieval_analytics";
