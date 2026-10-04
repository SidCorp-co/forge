ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_decision_chk";--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "feedback_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_reports_feedback_uq" ON "agent_reports" USING btree ("feedback_id") WHERE feedback_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_route_chk" CHECK (num_nonnulls("agent_reports"."linked_issue_id", "agent_reports"."feedback_id") <= 1);--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_promoted_reviewed_chk" CHECK ("agent_reports"."feedback_id" IS NULL OR "agent_reports"."reviewed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_decision_chk" CHECK ("feedback_decisions"."decision" IN ('triaged', 'declined', 'verified', 'reopened', 'redacted', 'promoted'));