-- ISS-219: bell notices and master wakes for channel, contract and builder acts are outbox events written in the act's transaction, so the type check admits them.
--
-- ROLLBACK: re-add the constraint without the six new types; a row holding one of them makes that
-- rebuild fail, and is not deleted to let it pass.
--
-- A type narrowed out of the CHECK (error.sighted, retired by ISS-219 release) is checked against
-- the rows first: a row holding it aborts this migration naming it, and is never deleted here.

-- LOCKS. Drizzle applies every pending file in ONE transaction, so a lock taken here is held until
-- the batch commits. Every table touched by this file and the later file of its batch (0402)
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

DO $$
DECLARE n integer; ids text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ') INTO n, ids
    FROM (SELECT id FROM "pipeline_outbox" WHERE "type" = 'error.sighted' ORDER BY id LIMIT 5) r;
  IF n > 0 THEN
    RAISE EXCEPTION 'pipeline_outbox rows % (first 5) are of type error.sighted, a type no consumer reads since ISS-219 retired it; the type check cannot be rebuilt over them', ids;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'schedule.fired', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'skill.globalUpdated', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'ecosystem.buildOwed'));
