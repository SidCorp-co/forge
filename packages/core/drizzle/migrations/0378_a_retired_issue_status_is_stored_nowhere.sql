-- The seventeen-status names leave the last places they were stored (ISS-161; ISS-174 deleted the
-- 17-to-10 map from the code). A run's opening statuses (`pipeline_runs.metadata.runIssueStatuses`,
-- the floor `returnIssuesForRun` hands an issue back to) naming a retired status are rewritten to
-- the status migration 0346 stored a row resting there as. A value that is neither one of the ten
-- nor a retired name aborts the migration, naming the run; nothing is guessed.
-- `issue_work_state.legacy_status`, which only the deleted map read, is dropped with its CHECK.

DO $$
DECLARE
  bad record;
BEGIN
  SELECT r.id, jsonb_typeof(r.metadata -> 'runIssueStatuses') AS shape INTO bad
    FROM pipeline_runs r
   WHERE r.metadata ? 'runIssueStatuses'
     AND jsonb_typeof(r.metadata -> 'runIssueStatuses') NOT IN ('object', 'null')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pipeline_runs %: metadata.runIssueStatuses is a JSON %, not a map of issue key to status', bad.id, bad.shape;
  END IF;

  SELECT r.id, e.key, e.value INTO bad
    FROM pipeline_runs r
    CROSS JOIN LATERAL jsonb_each(r.metadata -> 'runIssueStatuses') e
   WHERE jsonb_typeof(r.metadata -> 'runIssueStatuses') = 'object'
     AND (jsonb_typeof(e.value) <> 'string'
          OR e.value #>> '{}' NOT IN (
            'draft', 'open', 'reopen', 'in_progress', 'approved', 'needs_info', 'on_hold',
            'awaiting_release', 'closed', 'dropped',
            'confirmed', 'clarified', 'waiting', 'developed', 'testing', 'tested', 'releasing'))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'pipeline_runs %: metadata.runIssueStatuses.% holds %, which is neither one of the ten issue statuses nor a retired one', bad.id, bad.key, bad.value;
  END IF;
END $$;--> statement-breakpoint

UPDATE pipeline_runs r
   SET metadata = jsonb_set(
         r.metadata,
         '{runIssueStatuses}',
         (SELECT jsonb_object_agg(
                   e.key,
                   CASE e.value
                     WHEN 'confirmed' THEN 'open'
                     WHEN 'clarified' THEN 'open'
                     WHEN 'developed' THEN 'in_progress'
                     WHEN 'testing' THEN 'in_progress'
                     WHEN 'tested' THEN 'awaiting_release'
                     WHEN 'releasing' THEN 'awaiting_release'
                     WHEN 'waiting' THEN 'needs_info'
                     ELSE e.value
                   END)
            FROM jsonb_each_text(r.metadata -> 'runIssueStatuses') e))
 WHERE jsonb_typeof(r.metadata -> 'runIssueStatuses') = 'object'
   AND EXISTS (
     SELECT 1 FROM jsonb_each_text(r.metadata -> 'runIssueStatuses') e
      WHERE e.value IN ('confirmed', 'clarified', 'waiting', 'developed', 'testing', 'tested', 'releasing'));--> statement-breakpoint

ALTER TABLE "issue_work_state" DROP CONSTRAINT "issue_work_state_legacy_status_chk";--> statement-breakpoint
ALTER TABLE "issue_work_state" DROP COLUMN "legacy_status";
--> statement-breakpoint

-- A schedule fire settles in its session's own kernel move (`agent-sessions/session-transition.ts`),
-- so the trigger that wrote `schedule_runs.status` behind it is dropped. A session row deleted under
-- a running fire is no move of any machine, so that case keeps a trigger, which no longer writes
-- `schedules.last_status`: a schedule's last status is read from its newest fire and never stored.
DROP TRIGGER IF EXISTS trg_agent_sessions_stop_settles_its_fire ON agent_sessions;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_agent_sessions_delete_settles_its_fire ON agent_sessions;--> statement-breakpoint
DROP FUNCTION IF EXISTS forge_session_stop_settles_its_fire();--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_session_delete_settles_its_fire() RETURNS trigger AS $$
BEGIN
  UPDATE schedule_runs
     SET status = 'failed', finished_at = now(), error = 'session deleted'
   WHERE session_id = OLD.id
     AND status = 'running';
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER trg_agent_sessions_delete_settles_its_fire
  BEFORE DELETE ON agent_sessions
  FOR EACH ROW
  EXECUTE FUNCTION forge_session_delete_settles_its_fire();--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "last_status";
