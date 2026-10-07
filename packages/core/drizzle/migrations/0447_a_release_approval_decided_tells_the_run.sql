-- A release approval decided is an outbox event (`release.approvalDecided`), whose consumer tells the
-- release run that asked in its own session; the outbox's type check admits it.
--
-- ROLLBACK: DELETE FROM pipeline_outbox WHERE type = 'release.approvalDecided'; then restore the
-- check without it, as 0441 wrote it.

ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'question.asked', 'question.transitioned', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'contract.requested', 'ecosystem.buildOwed', 'requirement.agreed', 'requirement.returned', 'requirement.delivered', 'requirement.accepted', 'feedback.filed', 'feedback.verifyAsked', 'feedback.verifySettled', 'feedback.reporterTold', 'release.shipped', 'release.approvalDecided', 'credential.tokenChanged', 'runner.changed', 'job.changed', 'session.changed', 'device.pushed', 'session.pushed', 'issue.pushed', 'conversation.pushed'));
