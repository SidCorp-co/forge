-- One scheduler (ISS-170). The agents cron (`agents.schedule`) and the PM cadence
-- (`pm_config.cadence_cron`) are deleted: neither ever started a run, because the PM spawn they
-- called refuses every spawn `pool-job-no-prompt`, so a PM run on a timer is a prompt schedule.
-- Each project that still held a value is named in a NOTICE before the column goes.
-- `schedules.last_status`, `last_run_at` and `last_session_id` were stored copies of the newest
-- fire; they are read from schedule_runs now, so the session-stop trigger stops writing them first.
DO $$
DECLARE
  held text;
BEGIN
  SELECT string_agg(DISTINCT project_id::text || ' (' || schedule || ')', ', ') INTO held
    FROM agents WHERE schedule <> 'off';
  IF held IS NOT NULL THEN
    RAISE NOTICE 'agents.schedule dropped; these projects held one, which never started a run: %', held;
  END IF;
  SELECT string_agg(project_id::text || ' (' || cadence_cron || ')', ', ') INTO held
    FROM pm_config WHERE cadence_cron IS NOT NULL;
  IF held IS NOT NULL THEN
    RAISE NOTICE 'pm_config.cadence_cron dropped; these projects held one, which never started a run: %', held;
  END IF;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION forge_session_stop_settles_its_fire() RETURNS trigger AS $$
DECLARE
  ended text;
  detail text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    ended := 'failed';
    detail := 'session deleted';
  ELSE
    ended := CASE WHEN NEW.status IN ('completed', 'completed_via_recovery') THEN 'success' ELSE 'failed' END;
    detail := coalesce(NEW.failure_reason, 'session ' || NEW.status) || coalesce(': ' || NEW.failure_detail, '');
  END IF;
  UPDATE schedule_runs
     SET status = ended,
         finished_at = now(),
         error = CASE WHEN ended = 'failed' THEN detail END,
         refusal = CASE WHEN ended = 'failed' AND TG_OP <> 'DELETE'
                         AND NEW.failure_reason = 'session_authority_refused'
                         AND split_part(NEW.failure_detail, ':', 1) ~ '^[A-Z][A-Z0-9_]*$'
                        THEN split_part(NEW.failure_detail, ':', 1) END
   WHERE session_id = OLD.id
     AND status = 'running';
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "schedule";--> statement-breakpoint
ALTER TABLE "pm_config" DROP COLUMN "cadence_cron";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "last_run_at";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "last_status";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "last_session_id";
