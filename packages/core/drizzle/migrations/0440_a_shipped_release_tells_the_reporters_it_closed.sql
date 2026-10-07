-- A shipped release now tells the reporters of the feedback it closed (`release.shipped`, consumed by
-- notify-feedback), so the outbox type check is rebuilt from the registry with that one type added.
-- It only widens, so no stored row falls outside it.
--
-- ROLLBACK: re-add 0425's outbox type list after deleting any release.shipped rows.

ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'question.asked', 'question.transitioned', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'contract.requested', 'ecosystem.buildOwed', 'requirement.agreed', 'requirement.returned', 'requirement.delivered', 'requirement.accepted', 'feedback.filed', 'feedback.verifyAsked', 'feedback.verifySettled', 'release.shipped', 'credential.tokenChanged', 'runner.changed', 'job.changed', 'session.changed', 'device.pushed', 'session.pushed', 'issue.pushed', 'conversation.pushed'));
