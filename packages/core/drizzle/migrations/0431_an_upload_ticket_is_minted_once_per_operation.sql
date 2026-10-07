-- An upload ticket carries the operation id its caller minted, and the stored answer of the PUT
-- that consumed it, so a retry after a lost response is answered with the attachment already
-- stored instead of storing the file a second time. Unique per uploader and target: the same
-- operation id on the same room is one upload. NULL is a ticket minted before this column;
-- tickets live five minutes, so none is replayable, and every mint since names its operation.
--
-- The outbox type check also admits question.asked and question.transitioned, which tell open screens
-- a question changed.
--
-- ROLLBACK: rebuild pipeline_outbox_type_chk without those two types; DROP INDEX upload_tickets_operation_unique;
--           ALTER TABLE upload_tickets DROP COLUMN result, DROP COLUMN operation_id.

ALTER TABLE "upload_tickets" ADD COLUMN "operation_id" text;--> statement-breakpoint
ALTER TABLE "upload_tickets" ADD COLUMN "result" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "upload_tickets_operation_unique" ON "upload_tickets" ("uploader_id", "target_type", "target_id", "operation_id") WHERE "operation_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'question.asked', 'question.transitioned', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'contract.requested', 'ecosystem.buildOwed', 'requirement.agreed', 'requirement.returned', 'requirement.delivered', 'requirement.accepted', 'feedback.filed', 'feedback.verifyAsked', 'feedback.verifySettled', 'credential.tokenChanged', 'runner.changed', 'job.changed', 'session.changed', 'device.pushed', 'session.pushed', 'issue.pushed', 'conversation.pushed'));
