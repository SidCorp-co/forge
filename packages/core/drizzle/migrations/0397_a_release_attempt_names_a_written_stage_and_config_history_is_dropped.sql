-- ISS-219: a release attempt holds only the stages, verdicts and health readings a writer produces,
-- and the project config history that nothing reads is dropped.
--
-- ROLLBACK: none for the table. project_config_revisions is dropped with its contents and cannot
-- be recreated from the code or from this file; undoing it means restoring from a backup taken
-- before it ran. The three CHECKs can be dropped again by hand.
--
-- A value these CHECKs exclude is checked against the rows first: a row holding one aborts this
-- migration naming that row, and is never deleted or relabelled here.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. Every table this file touches is locked up front, in one fixed order
-- (alphabetical), before any statement holds a lock a live session could be waiting behind; a
-- table that stays busy past lock_timeout fails the deploy loudly instead of deadlocking mid-file.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_config_revisions', 'release_attempts'] LOOP
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
DROP FUNCTION IF EXISTS project_config_revisions_write_once();
