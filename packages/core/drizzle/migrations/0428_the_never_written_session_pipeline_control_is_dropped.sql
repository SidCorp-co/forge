-- agent_sessions.pipeline_control is dropped: nothing in core has written it since the session pause
-- and abort it was typed for went, dev holds 0 rows with a value, and the one reader was the
-- agent-session list returning it null. A row that still holds a value aborts this migration naming
-- that row, so nothing written here is deleted unread.
--
-- ROLLBACK: re-add the column as `jsonb` (nullable); there is nothing to restore into it.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  SELECT id INTO r FROM "agent_sessions" WHERE "pipeline_control" IS NOT NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent_sessions % holds a pipeline_control value, which this migration would delete unread; read it and set the column to NULL before this migration', r.id;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "pipeline_control";
