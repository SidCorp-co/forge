-- ISS-219: bell notices and master wakes for channel, contract and builder acts are outbox events written in the act's transaction, so the type check admits them.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "pipeline_outbox" WHERE "type" = 'error.sighted';
  IF n > 0 THEN
    RAISE EXCEPTION 'pipeline_outbox holds % row(s) of type error.sighted, a type no consumer reads since ISS-219 retired it; the type check cannot be rebuilt over them', n;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'schedule.fired', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'skill.globalUpdated', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'ecosystem.buildOwed'));
