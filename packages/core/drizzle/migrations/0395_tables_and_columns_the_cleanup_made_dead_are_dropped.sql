-- ISS-226: the tables and columns the cleanup lanes (ISS-208..222) left with no reader and no writer
-- are dropped, and the two stored shapes the code no longer reads are repaired.
--
-- ROLLBACK: none. This migration deletes tables, columns and rows; they cannot be recreated from
-- the code or from this file. Undoing it means restoring the database from a backup taken before
-- it ran.
--
-- Each object below has no reader, writer, trigger or view left in the code, and no kept table holds
-- a foreign key to one (the only two are between tables dropped together). Its guard trigger function
-- goes with it.
--
-- contract waits, change requests and land measurements (ISS-214)
DROP TABLE IF EXISTS "issue_contract_waits" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "contract_requests" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS issue_contract_wait_guard();--> statement-breakpoint
DROP FUNCTION IF EXISTS contract_request_guard();--> statement-breakpoint
DROP TABLE IF EXISTS "contract_measurements" CASCADE;--> statement-breakpoint

-- chunked memory, knowledge edges and the task list (ISS-214, ISS-209)
DROP TABLE IF EXISTS "memory_chunks" CASCADE;--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "chunk_generation";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN IF EXISTS "chunked_at";--> statement-breakpoint
DROP TABLE IF EXISTS "knowledge_edges" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tasks" CASCADE;--> statement-breakpoint

-- token fence edit log and the What's New pointer (ISS-215)
DROP TABLE IF EXISTS "pat_fence_changes" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS pat_fence_change_guard();--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "last_seen_whats_new";--> statement-breakpoint

-- the git credential pool (ISS-215, ISS-222); the credential row references the key, so it goes first
DROP TABLE IF EXISTS "project_git_credentials" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "workspace_ssh_keys" CASCADE;--> statement-breakpoint

-- improvement message versions on a schedule (ISS-208); `template_key` and `mode` stay, still read
ALTER TABLE "schedules" DROP COLUMN IF EXISTS "applied_message_versions";--> statement-breakpoint

-- the PM job's per-project index (ISS-208, ISS-209): no job of type 'pm' is produced
DROP INDEX IF EXISTS "jobs_pm_per_project_unique_idx";--> statement-breakpoint

-- assistant settings whose only reader or writer was deleted (ISS-213, ISS-214); the table stays
ALTER TABLE "app_config" DROP COLUMN IF EXISTS "retrieval_top_k";--> statement-breakpoint
ALTER TABLE "app_config" DROP COLUMN IF EXISTS "retrieval_min_score";--> statement-breakpoint
ALTER TABLE "app_config" DROP COLUMN IF EXISTS "enabled_channels";--> statement-breakpoint
ALTER TABLE "app_config" DROP COLUMN IF EXISTS "memory_model";--> statement-breakpoint
ALTER TABLE "app_config" DROP COLUMN IF EXISTS "memory_reindex";--> statement-breakpoint
ALTER TABLE "app_config" DROP COLUMN IF EXISTS "last_backfill_at";--> statement-breakpoint

-- The Google Sheets adapter is gone (ISS-211), so a Google connection names a provider the registry
-- refuses. Sign-in with Google is an identity provider and stores nothing here.
DELETE FROM "integration_bindings" WHERE "provider" = 'google';--> statement-breakpoint
DELETE FROM "integration_guides" WHERE "provider" = 'google';--> statement-breakpoint
DELETE FROM "integration_connections" WHERE "provider" = 'google';--> statement-breakpoint

-- The ecosystem schema no longer has `releases` (its one key, `providerLive`, went with the contract
-- waits in ISS-214) and is strict, so a stored document still carrying it fails to parse. A revision
-- is write-once by trigger; the trigger is lifted for this one repair and put back.
UPDATE "ecosystems" SET "document" = "document" - 'releases' WHERE "document" ? 'releases';--> statement-breakpoint
ALTER TABLE "ecosystem_revisions" DISABLE TRIGGER "ecosystem_revisions_write_once_trg";--> statement-breakpoint
UPDATE "ecosystem_revisions" SET "document" = "document" - 'releases' WHERE "document" ? 'releases';--> statement-breakpoint
ALTER TABLE "ecosystem_revisions" ENABLE TRIGGER "ecosystem_revisions_write_once_trg";--> statement-breakpoint

-- A version 2 workflow document written before templates names none; it was drawn in
-- `operational-flow@1`, and core read it as that. It now says so, and core reads only what is stored.
-- The design fingerprint already treats `operational-flow@1` as absent, so no approval moves.
UPDATE "project_workflow_designs"
   SET "document" = "document" || '{"template":{"id":"operational-flow","version":1}}'::jsonb
 WHERE "document"->>'version' = '2' AND NOT "document" ? 'template';--> statement-breakpoint
UPDATE "project_workflows"
   SET "document" = "document" || '{"template":{"id":"operational-flow","version":1}}'::jsonb
 WHERE "document"->>'version' = '2' AND NOT "document" ? 'template';--> statement-breakpoint

-- Outbox event types the code no longer emits or consumes: the dependency and task events (ISS-209)
-- and `skill.registered` (ISS-220). Their rows and delivery jobs go, and the type CHECK is rebuilt from
-- `OUTBOX_EVENT_TYPES`, which also adds `workflow.designDecided` (ISS-201 emits it; the old CHECK
-- refused it).
DELETE FROM "pipeline_outbox"
 WHERE "type" IN ('dependency.changed', 'task.created', 'task.updated', 'task.deleted', 'skill.registered');--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'schedule.fired', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'skill.globalUpdated', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'error.sighted', 'integration.changed', 'workflow.designDecided'));--> statement-breakpoint

-- Queues no worker serves any longer: land measurement and the two chunk jobs (ISS-214). A waiting
-- job there would wait for ever. pg-boss 12 creates its schema when core starts, after this runs, so
-- a fresh database has none to clean.
DO $$
DECLARE
  q text;
BEGIN
  IF to_regprocedure('pgboss_v12.delete_queue(text)') IS NULL THEN
    RETURN;
  END IF;
  FOREACH q IN ARRAY ARRAY[
    'ecosystem-contract-measure',
    'memory-chunk-purge',
    'memory-chunk-reindex'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pgboss_v12.queue WHERE name = q) THEN
      PERFORM pgboss_v12.delete_queue(q);
    END IF;
  END LOOP;
  -- A delivery of a dropped event type, live or dead, names a type no consumer knows.
  DELETE FROM pgboss_v12.job
   WHERE name LIKE 'outbox.%'
     AND data->>'type' IN ('dependency.changed', 'task.created', 'task.updated', 'task.deleted', 'skill.registered');
END $$;
