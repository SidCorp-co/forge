-- Cleanup round 2: schema with no reader is dropped, and the feedback case that feedback-triage r4
-- removed goes with it (requirement-to-delivery `fb-case`: the FB-n row and its group are the case).
-- Issue attributes lost their only door (the /issues/:id/attributes routes) and every reader, and the
-- outbox types schedule.fired and skill.globalUpdated lost their emitters and their one consumer.
--
-- ROLLBACK: none for the contents. feedback_cases, issue_attributes, prompt_blobs, the jobs prompt
-- snapshot columns and the two retired outbox types' rows were written and never read; they are deleted with their rows and cannot be recreated from the code
-- or this file (a triage's route stays on feedback_decisions). Undoing it means restoring from a
-- backup taken before it ran. skills_scope_check can be widened again by hand.
--
-- A column dropped here as never written is checked first: a row holding a value aborts this
-- migration naming that row, since it means a writer exists that this cleanup did not see.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. Every table touched by this file is locked up front, in one fixed order
-- (alphabetical), before any statement holds a lock a live session could be waiting behind; a table
-- that stays busy past lock_timeout fails the deploy loudly instead of deadlocking mid-file. A table
-- this database never had is skipped.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_reports', 'agent_session_turns', 'feedback_cases', 'integration_connections',
    'issue_attribute_defs', 'issue_attributes', 'jobs', 'pipeline_outbox',
    'prompt_blobs', 'skills', 'usage_records'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', to_regclass(t));
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

DO $$
DECLARE r record;
BEGIN
  SELECT id INTO r FROM "jobs" WHERE "archive_path" IS NOT NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'jobs % holds archive_path, which no code writes; find its writer before this migration drops the column', r.id;
  END IF;
  SELECT id INTO r FROM "agent_reports" WHERE "skill_name" IS NOT NULL OR "skill_version" IS NOT NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent_reports % holds skill_name or skill_version, which no code writes; find its writer before this migration drops them', r.id;
  END IF;
  SELECT id INTO r FROM "skills" WHERE "user_id" IS NOT NULL OR "scope" = 'user' LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'skills % is user-scoped, which no code writes and skills_scope_check will no longer allow; remove or rescope it before this migration', r.id;
  END IF;
  SELECT id INTO r FROM "integration_connections" WHERE "oauth_installation_id" IS NOT NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'integration_connections % holds oauth_installation_id, which no code writes; find its writer before this migration drops the column', r.id;
  END IF;
  SELECT id INTO r FROM "usage_records" WHERE "project_name" IS NOT NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'usage_records % holds project_name, which no code writes; find its writer before this migration drops the column', r.id;
  END IF;
  SELECT id INTO r FROM "agent_session_turns" WHERE "parent_turn_id" IS NOT NULL LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'agent_session_turns % holds parent_turn_id, which no code writes; find its writer before this migration drops the column', r.id;
  END IF;
END $$;--> statement-breakpoint

DROP TABLE "feedback_cases";--> statement-breakpoint
DROP INDEX "jobs_finished_archive_idx";--> statement-breakpoint
ALTER TABLE "jobs"
  DROP COLUMN "system_prompt_hash",
  DROP COLUMN "user_prompt_snapshot",
  DROP COLUMN "prompt_input_token_est",
  DROP COLUMN "prompt_blocks",
  DROP COLUMN "archive_path";--> statement-breakpoint
DROP TABLE "prompt_blobs";--> statement-breakpoint
ALTER TABLE "agent_reports" DROP COLUMN "skill_name", DROP COLUMN "skill_version";--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_scope_check";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_scope_check" CHECK (
  ("scope" = 'global' AND "project_id" IS NULL) OR ("scope" = 'project' AND "project_id" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "integration_connections" DROP COLUMN "oauth_installation_id";--> statement-breakpoint
ALTER TABLE "usage_records" DROP COLUMN "project_name";--> statement-breakpoint
ALTER TABLE "agent_session_turns" DROP COLUMN "parent_turn_id";;--> statement-breakpoint
DROP TABLE "issue_attributes";--> statement-breakpoint
DROP TABLE "issue_attribute_defs";--> statement-breakpoint
-- Their deliveries were pg-boss jobs to ws-broadcast and are long done; the rows are dropped.
DELETE FROM "pipeline_outbox" WHERE "type" IN ('schedule.fired', 'skill.globalUpdated');--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'ecosystem.buildOwed'));
