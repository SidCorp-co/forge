-- ISS-219: a notification's dedupe key is unique where it is set, the deleted "Build Project Brain"
-- skill leaves the skills table, the jobs indexes stop naming the job state 'running' that machine
-- v2 removed, and the outbox type check admits issue.dependency.changed.
--
-- ROLLBACK: the indexes and the CHECK can be rebuilt by hand as they were. The forge-onboard skill
-- rows and their activity rows are deleted and cannot be recreated from this file; the seeder no
-- longer ships that skill.
--
-- Nothing here deletes a row to make a new shape fit: a duplicate dedupe key or a job still at
-- 'running' aborts this migration naming the rows.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. Every table touched by this file
-- is locked up front, in one fixed order (alphabetical), before any statement holds a lock a live
-- session could be waiting behind; a table that stays busy past lock_timeout fails the deploy loudly
-- instead of deadlocking mid-file. A table this database never had is skipped.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'device_skills', 'jobs', 'notifications', 'pipeline_outbox', 'reconcile_runs',
    'skill_activity_events', 'skill_registrations', 'skills'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(t));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- notifications.dedupe_key: deliver.ts looks a key up before it inserts, which two concurrent
-- deliveries can both pass; the unique index makes the second insert fail instead of duplicating.
DO $$
DECLARE r record;
BEGIN
  SELECT dedupe_key, min(id::text) AS a, max(id::text) AS b, count(*) AS n INTO r
    FROM "notifications" WHERE "dedupe_key" IS NOT NULL
   GROUP BY dedupe_key HAVING count(*) > 1 ORDER BY dedupe_key LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'notifications % and % (% rows) share dedupe_key %, which notifications_dedupe_key_uq refuses; resolve the duplicates before this migration', r.a, r.b, r.n, r.dedupe_key;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "notifications_dedupe_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_uq" ON "notifications" ("dedupe_key") WHERE "dedupe_key" IS NOT NULL;--> statement-breakpoint

-- The global forge-onboard skill and every project copy installed from it; their activity rows cascade.
DELETE FROM "skills"
 WHERE "name" = 'forge-onboard'
   AND ("scope" = 'global'
        OR "based_on_global_skill_id" IN (SELECT "id" FROM "skills" WHERE "scope" = 'global' AND "name" = 'forge-onboard'));--> statement-breakpoint

-- Job machine v2 has no 'running' state (contracts job-machine, ISS-219 execution). jobs.status
-- carries no CHECK, so a row still at 'running' would fall out of every rebuilt index below.
DO $$
DECLARE n integer; ids text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ') INTO n, ids
    FROM (SELECT id FROM "jobs" WHERE "status" = 'running' ORDER BY id LIMIT 5) r;
  IF n > 0 THEN
    RAISE EXCEPTION 'jobs % (first 5) are at status running, which job machine v2 no longer holds; move them to a v2 state before this migration', ids;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "jobs_active_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_unique" ON "jobs" ("issue_id", "type") WHERE "status" IN ('queued', 'dispatched', 'held') AND "issue_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "jobs_runner_active_idx";--> statement-breakpoint
CREATE INDEX "jobs_runner_active_idx" ON "jobs" ("runner_id") WHERE "status" = 'dispatched';--> statement-breakpoint
DROP INDEX IF EXISTS "jobs_release_batch_per_project_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_release_batch_per_project_unique_idx" ON "jobs" ("project_id") WHERE "type" = 'release_batch' AND "status" IN ('queued', 'dispatched');--> statement-breakpoint

-- The edge write emits issue.dependency.changed in its own transaction (ISS-219 work).
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'schedule.fired', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'skill.globalUpdated', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'ecosystem.buildOwed'));
