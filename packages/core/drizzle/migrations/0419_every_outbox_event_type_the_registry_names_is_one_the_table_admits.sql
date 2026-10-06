-- The outbox type check last written by 0405 admitted 28 of the 43 types `OUTBOX_EVENT_TYPES`
-- names, so every emit of the other 15 failed its whole transaction: requirement agree, contract
-- requests, feedback, credential and runner changes, and every live push (`conversation.pushed`
-- lost the BA room's reply). The check is rebuilt from the registry as it stands; it only widens,
-- so no stored row can fall outside it. `src/db/schema-checks.test.ts` now fails while the schema
-- and the last migration to define a CHECK disagree, so the next type added is caught before merge.
--
-- ROLLBACK: re-add 0405's list; it refuses any row of the 15 types written since, so delete those
-- first (their pg-boss deliveries have run).

ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'contract.requested', 'ecosystem.buildOwed', 'requirement.agreed', 'requirement.delivered', 'requirement.accepted', 'feedback.filed', 'feedback.verifyAsked', 'feedback.verifySettled', 'credential.tokenChanged', 'runner.changed', 'job.changed', 'session.changed', 'device.pushed', 'session.pushed', 'issue.pushed', 'conversation.pushed'));
