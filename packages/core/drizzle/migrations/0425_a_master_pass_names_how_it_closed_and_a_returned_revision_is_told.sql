-- A closed master pass names how it ended, as the box that closed it judged it: its turn ended, or it
-- was abandoned (quiet, a daemon restart, an orphan core held), closed with its session, or closed at
-- once because the box could not record it. Before this, a quiet-abandoned pass and a pass whose turn
-- ended read the same (F37). Rows closed before it, and passes a runner older than this closes, carry
-- none, which reads as unstated; nothing recorded the reason for them, so none is invented.
--
-- A returned requirement revision is now told on the outbox (`requirement.returned`), so the master
-- that runs the agent which wrote it is woken to revise it (F32); the outbox type check is rebuilt
-- from the registry with that one type added. It only widens, so no stored row falls outside it.
--
-- ROLLBACK: ALTER TABLE master_passes DROP CONSTRAINT master_passes_close_reason_chk;
--           ALTER TABLE master_passes DROP COLUMN close_reason;
--           re-add 0419's outbox type list after deleting any requirement.returned rows.

ALTER TABLE "master_passes" ADD COLUMN "close_reason" text;--> statement-breakpoint
ALTER TABLE "master_passes" ADD CONSTRAINT "master_passes_close_reason_chk" CHECK ("master_passes"."close_reason" IS NULL OR ("master_passes"."ended_at" IS NOT NULL AND "master_passes"."close_reason" IN ('turn_ended', 'abandoned_quiet', 'abandoned_restart', 'abandoned_orphan', 'session_gone', 'unrecorded')));--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'contract.requested', 'ecosystem.buildOwed', 'requirement.agreed', 'requirement.returned', 'requirement.delivered', 'requirement.accepted', 'feedback.filed', 'feedback.verifyAsked', 'feedback.verifySettled', 'credential.tokenChanged', 'runner.changed', 'job.changed', 'session.changed', 'device.pushed', 'session.pushed', 'issue.pushed', 'conversation.pushed'));
