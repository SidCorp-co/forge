-- A feedback triager can snooze an item, accept it without routing it, and message its reporters.
-- `feedback.snoozed_until` and `snooze_reason` hold a snooze (both or neither, and only while the item
-- is new or reopened, so every act that moves it off those clears them); two decision values,
-- `accepted` and `snoozed`, are added and a snooze, like a decline, must carry a reason;
-- `feedback_messages` keeps each message to reporters and each internal note (an internal note has no
-- recipients by CHECK, so no notice can have been addressed from one); the outbox type check gains
-- `feedback.reporterTold`, the one event that tells reporters of a decline, a duplicate or a message.
-- Forge itself can verify a resolved item nobody confirmed (`feedback.resolved_seen_at` dates when a
-- sweep first read it resolved; `decided_agency` gains `system`, whose decision has no person and so
-- no `decided_by`). Every change only widens or adds, so no stored row falls outside it.
--
-- ROLLBACK: DROP TABLE feedback_messages; ALTER TABLE feedback DROP CONSTRAINT feedback_snooze_chk,
--           DROP COLUMN snoozed_until, DROP COLUMN snooze_reason; then re-add 0426's decision list and
--           0440's outbox list after deleting any `accepted`/`snoozed` decision and any
--           feedback.reporterTold outbox row; system decisions are deleted or given an owner before
--           `decided_by` is set NOT NULL again.

ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "snooze_reason" text;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_snooze_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_snooze_chk" CHECK (("feedback"."snoozed_until" IS NULL) = ("feedback"."snooze_reason" IS NULL) AND ("feedback"."snoozed_until" IS NULL OR ("feedback"."snooze_reason" ~ '[^[:space:]]' AND "feedback"."status" IN ('new', 'reopened'))));--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "resolved_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback_decisions" ALTER COLUMN "decided_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT IF EXISTS "feedback_decisions_agency_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_agency_chk" CHECK ("feedback_decisions"."decided_agency" IN ('human', 'agent', 'system') AND (("feedback_decisions"."decided_agency" = 'system') = ("feedback_decisions"."decided_by" IS NULL)));--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_decision_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_decision_chk" CHECK ("feedback_decisions"."decision" IN ('triaged', 'declined', 'verified', 'reopened', 'redacted', 'promoted', 'routed', 'retargeted', 'accepted', 'snoozed'));--> statement-breakpoint
ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_reason_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_reason_chk" CHECK ("feedback_decisions"."decision" NOT IN ('declined', 'reopened', 'snoozed') OR "feedback_decisions"."reason" ~ '[^[:space:]]');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"feedback_id" uuid NOT NULL,
	"audience" text NOT NULL,
	"body" text NOT NULL,
	"recipients" uuid[] DEFAULT '{}' NOT NULL,
	"sent_by" uuid NOT NULL,
	"sent_agency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_messages_audience_chk" CHECK ("feedback_messages"."audience" IN ('reporter', 'all_reporters', 'internal')),
	CONSTRAINT "feedback_messages_body_chk" CHECK ("feedback_messages"."body" ~ '[^[:space:]]'),
	CONSTRAINT "feedback_messages_internal_chk" CHECK ("feedback_messages"."audience" <> 'internal' OR cardinality("feedback_messages"."recipients") = 0),
	CONSTRAINT "feedback_messages_agency_chk" CHECK ("feedback_messages"."sent_agency" IN ('human', 'agent'))
);--> statement-breakpoint
ALTER TABLE "feedback_messages" DROP CONSTRAINT IF EXISTS "feedback_messages_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_messages" DROP CONSTRAINT IF EXISTS "feedback_messages_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_messages" DROP CONSTRAINT IF EXISTS "feedback_messages_sent_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_messages_feedback_idx" ON "feedback_messages" USING btree ("feedback_id","created_at");--> statement-breakpoint
ALTER TABLE "pipeline_outbox" DROP CONSTRAINT IF EXISTS "pipeline_outbox_type_chk";--> statement-breakpoint
ALTER TABLE "pipeline_outbox" ADD CONSTRAINT "pipeline_outbox_type_chk" CHECK ("type" IN ('issue.created', 'issue.updated', 'issue.transitioned', 'issue.dependency.changed', 'job.transitioned', 'run.transitioned', 'comment.created', 'comment.updated', 'comment.deleted', 'comment.mentioned', 'question.answered', 'question.asked', 'question.transitioned', 'notification.created', 'notification.read', 'user.preferencesChanged', 'skill.syncRequested', 'runner.provisionRequested', 'runner.provisionStatus', 'source.pushed', 'source.merged', 'source.reviewed', 'integration.changed', 'workflow.designDecided', 'channel.documentPublished', 'channel.gateAsked', 'channel.gateDecided', 'channel.threadHeld', 'contract.versionApproved', 'contract.requested', 'ecosystem.buildOwed', 'requirement.agreed', 'requirement.returned', 'requirement.delivered', 'requirement.accepted', 'feedback.filed', 'feedback.verifyAsked', 'feedback.verifySettled', 'release.shipped', 'feedback.reporterTold', 'credential.tokenChanged', 'runner.changed', 'job.changed', 'session.changed', 'device.pushed', 'session.pushed', 'issue.pushed', 'conversation.pushed'));
