-- ISS-219: a release attempt holds only the stages, verdicts and health readings a writer produces;
-- the project config history and schedules.metadata, which nothing reads, are dropped; and the
-- deleted desktop chat mode leaves usage_records.source.
--
-- ROLLBACK: none for the table or the column. project_config_revisions and schedules.metadata are
-- dropped with their contents and cannot be recreated from the code or from this file; undoing it
-- means restoring from a backup taken before it ran. The four CHECKs can be dropped again by hand.
--
-- A value these CHECKs exclude is checked against the rows first: a row holding one aborts this
-- migration naming that row, and is never deleted or relabelled here.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. Every table touched by this file and the later files of its batch (0399-0402)
-- is locked up front, in one fixed order (alphabetical), before any statement holds a lock a live
-- session could be waiting behind; a table that stays busy past lock_timeout fails the deploy loudly
-- instead of deadlocking mid-file. A table this database never had is skipped.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app_config', 'device_skills', 'jobs', 'notifications', 'phase_journal', 'pipeline_outbox',
    'project_config_revisions', 'projects', 'reconcile_runs', 'release_attempts', 'schedules',
    'skill_activity_events', 'skill_registrations', 'skills', 'usage_records', 'users'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(t));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- 'promote' and 'repair' lost their writer with the attempts route (ISS-213); a release run's
-- production deploy now records 'deploy', and a recorded release 'verify' (`RELEASE_ATTEMPT_STAGES`).
DO $$
DECLARE r record;
BEGIN
  SELECT id, stage INTO r FROM "release_attempts" WHERE "stage" NOT IN ('deploy', 'verify') LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'release_attempts % has stage %, which release_attempts_stage_chk does not allow; relabel or remove it before this migration', r.id, r.stage;
  END IF;
  SELECT id, verdict INTO r FROM "release_attempts" WHERE "verdict" NOT IN ('ok', 'failed', 'unverified') LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'release_attempts % has verdict %, which release_attempts_verdict_chk does not allow; relabel or remove it before this migration', r.id, r.verdict;
  END IF;
  SELECT id, health INTO r FROM "release_attempts" WHERE "health" NOT IN ('up', 'down') LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'release_attempts % has health %, which release_attempts_health_chk does not allow; relabel or remove it before this migration', r.id, r.health;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "release_attempts" ADD CONSTRAINT "release_attempts_stage_chk" CHECK ("release_attempts"."stage" IN ('deploy', 'verify'));--> statement-breakpoint
ALTER TABLE "release_attempts" ADD CONSTRAINT "release_attempts_verdict_chk" CHECK ("release_attempts"."verdict" IS NULL OR "release_attempts"."verdict" IN ('ok', 'failed', 'unverified'));--> statement-breakpoint
ALTER TABLE "release_attempts" ADD CONSTRAINT "release_attempts_health_chk" CHECK ("release_attempts"."health" IS NULL OR "release_attempts"."health" IN ('up', 'down'));--> statement-breakpoint

-- Written on every project document write and read by nothing since GET /config/revisions went
-- (ISS-213); the compare-and-set base is project_config_documents.revision, not this table.
DROP TABLE IF EXISTS "project_config_revisions";--> statement-breakpoint
DROP FUNCTION IF EXISTS project_config_revisions_write_once();;--> statement-breakpoint

-- The schedule's free-form metadata lost its last writer with the schedule doors' `metadata` field
-- (ISS-219 execution); nothing ever read it back.
ALTER TABLE "schedules" DROP COLUMN IF EXISTS "metadata";--> statement-breakpoint

-- The local desktop chat mode is deleted, and with it the only path that could have recorded usage
-- as 'desktop'; usage is recorded as 'cli' (agent-sessions/usage-materialize.ts). The column had no
-- CHECK, so `usageSources` was enforced by nothing in the database.
DO $$
DECLARE r record;
BEGIN
  SELECT id, source INTO r FROM "usage_records" WHERE "source" NOT IN ('cli', 'api') LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'usage_records % has source %, which usage_records_source_chk does not allow; relabel or remove it before this migration', r.id, r.source;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_source_chk" CHECK ("usage_records"."source" IN ('cli', 'api'));
