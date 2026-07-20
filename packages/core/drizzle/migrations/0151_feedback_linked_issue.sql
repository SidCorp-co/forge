-- ISS-712 — `feedback_reports.linked_issue_id`: the issue a report was
-- curated INTO (distinct from the existing `issue_id`, which is the SOURCE
-- issue the agent was working on when it emitted the report). Set only via
-- the `review` action's explicit linkedIssueId param — never auto-stamped.

ALTER TABLE "feedback_reports" ADD COLUMN "linked_issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_linked_issue_id_issues_id_fk"
	FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "feedback_reports_linked_issue_id_idx" ON "feedback_reports" USING btree ("linked_issue_id");
