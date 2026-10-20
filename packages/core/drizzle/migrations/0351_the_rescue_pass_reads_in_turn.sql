-- ISS-1228 r21 — the rescue pass (pipeline/reconciler.ts runReconcilerOnce) read its stuck-issue
-- candidates with LIMIT 100 and no ORDER BY, so on a database holding thousands of them the same rows
-- came back every minute and the rest were never reached. The pass now reads the longest-unread first
-- and stamps each row it took here.
--
-- Additive and empty: an issue with no row here has never been read and sorts first, so no backfill.
-- Rollback: a reverted build reads nothing here; drop the table only in a follow-up migration.
CREATE TABLE IF NOT EXISTS "reconciler_examined" (
  "issue_id" uuid PRIMARY KEY NOT NULL
    CONSTRAINT "reconciler_examined_issue_id_issues_id_fk" REFERENCES "issues"("id") ON DELETE CASCADE,
  "examined_at" timestamp with time zone NOT NULL
);
