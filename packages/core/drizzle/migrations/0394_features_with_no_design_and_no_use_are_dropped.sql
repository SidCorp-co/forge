-- ISS-220: features with no design backing and no usage are deleted, and so is what they stored.
-- Each table below has no reader left in the code; no kept table holds a foreign key to one, and no
-- view reads one. The status guards 0393 put on `reconcile_runs` and `rocketchat_comment_mirrors`
-- go with their tables; their `kernel_transitions` history stays, as every machine's does.
--
-- chat audit log, Rocket.Chat comment mirror, assistant agents, domain templates, skill
-- registration/reconcile/update-packet lane, PM agent, runner release records, outbound webhooks,
-- admin thresholds (now fixed defaults), notification silences, and five one-shot backups whose
-- migrations have shipped everywhere.
DROP TABLE IF EXISTS "chat_logs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "rocketchat_comment_mirrors" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "rocketchat_comment_mirror_state" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "rocketchat_thread_openings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agents" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "domain_templates" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "skill_registrations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "device_skills" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "reconcile_runs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "update_packets" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "divergence_charters" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pm_decisions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pm_config" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "pm_policies" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "runner_releases" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "project_webhooks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "admin_thresholds" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "notification_silences" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "project_facts_migration_backup" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "iss1071_agent_access_set" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "iss1071_removed_mcp_sentinels" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "ux_contract_retirement_backup" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "ux_contract_retirement_backup_schedules" CASCADE;--> statement-breakpoint

-- A Rocket.Chat thread now carries a question and nothing else. An issue thread belonged to the
-- comment mirror, which is gone; nothing reads one, so it is deleted rather than left unreadable.
DELETE FROM "rocketchat_question_threads" WHERE "issue_id" IS NOT NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "rcq_threads_issue_live_idx";--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" DROP CONSTRAINT IF EXISTS "rcq_threads_subject_chk";--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" DROP COLUMN IF EXISTS "issue_id";--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" DROP COLUMN IF EXISTS "retired_at";--> statement-breakpoint
ALTER TABLE "rocketchat_question_threads" ALTER COLUMN "question_id" SET NOT NULL;--> statement-breakpoint

-- Git credential provisioning was flag-off everywhere; the device column it stamped goes.
ALTER TABLE "devices" DROP COLUMN IF EXISTS "git_credential_ref";--> statement-breakpoint

-- The Postman adapter is gone, so a Postman connection names a provider the registry refuses.
DELETE FROM "integration_bindings" WHERE "provider" = 'postman';--> statement-breakpoint
DELETE FROM "integration_connections" WHERE "provider" = 'postman';--> statement-breakpoint

-- The two built-in skills of the deleted reconcile and verify lanes; their activity rows cascade.
DELETE FROM "skills" WHERE "scope" = 'global' AND "name" IN ('forge-reconcile', 'forge-verify-skill');--> statement-breakpoint

-- The weekly assistant report's settings key would now be refused as undeclared on the next PATCH.
UPDATE "projects" SET "agent_config" = "agent_config" - 'assistantWeekly' WHERE "agent_config" ? 'assistantWeekly';--> statement-breakpoint

-- Queues no worker serves any longer: the weekly report, the PM timers, the webhook delivery pair
-- and the three deleted outbox consumers. A waiting job there would wait for ever. pg-boss 12
-- creates its schema when core starts, after this runs, so a fresh database has none to clean.
-- The dead-letter queue goes after the queue that names it.
DO $$
DECLARE
  q text;
BEGIN
  IF to_regprocedure('pgboss_v12.delete_queue(text)') IS NULL THEN
    RETURN;
  END IF;
  FOREACH q IN ARRAY ARRAY[
    'assistant-weekly-report',
    'pm.escalation-sweeper',
    'pm.queue-pressure',
    'outbox.outbound-webhooks',
    'outbox.pm',
    'outbox.rocketchat-comment-mirror',
    'webhook-delivery',
    'webhook-delivery-dead'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pgboss_v12.queue WHERE name = q) THEN
      PERFORM pgboss_v12.delete_queue(q);
    END IF;
  END LOOP;
  -- A dead copy of a deleted consumer's delivery could only be replayed onto a queue that is gone.
  DELETE FROM pgboss_v12.job
   WHERE name = 'outbox.dead'
     AND data->>'consumer' IN ('outbound-webhooks', 'pm', 'rocketchat-comment-mirror');
END $$;
