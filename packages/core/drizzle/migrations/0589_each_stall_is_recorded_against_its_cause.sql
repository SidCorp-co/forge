-- Each delivery stall is recorded against the item that caused it, with the question it raised
-- (ISS-696, REQ-67 BC-6), so each release counts its stalls by cause (BC-7). A new table: core writes
-- a row in the transaction of the act that starts a stall (a question about a requirement or feedback
-- item, a reporter's clarification, a failed verdict's reopen, a `needs_info` park on a person) and
-- ends it in the act that clears it. No stall is backfilled: before this migration none was recorded.
--
-- ROLLBACK: DROP TABLE IF EXISTS "stalls";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stalls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"cause" text NOT NULL,
	"requirement_id" uuid,
	"feedback_id" uuid,
	"issue_id" uuid,
	"question_id" uuid,
	"question" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" text,
	CONSTRAINT "stalls_cause_chk" CHECK ("stalls"."cause" IN ('unclear_item', 'defect', 'waiting_on_person')),
	CONSTRAINT "stalls_ended_by_chk" CHECK (("stalls"."ended_at" IS NULL) = ("stalls"."ended_by" IS NULL) AND ("stalls"."ended_by" IS NULL OR "stalls"."ended_by" IN ('answered', 'withdrawn', 'merged', 'dropped', 'resumed'))),
	CONSTRAINT "stalls_placed_chk" CHECK (CASE "stalls"."cause" WHEN 'unclear_item' THEN "stalls"."requirement_id" IS NOT NULL OR "stalls"."feedback_id" IS NOT NULL ELSE "stalls"."issue_id" IS NOT NULL END)
);
--> statement-breakpoint
ALTER TABLE "stalls" DROP CONSTRAINT IF EXISTS "stalls_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "stalls" ADD CONSTRAINT "stalls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stalls" DROP CONSTRAINT IF EXISTS "stalls_requirement_id_requirements_id_fk";--> statement-breakpoint
ALTER TABLE "stalls" ADD CONSTRAINT "stalls_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stalls" DROP CONSTRAINT IF EXISTS "stalls_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "stalls" ADD CONSTRAINT "stalls_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stalls" DROP CONSTRAINT IF EXISTS "stalls_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "stalls" ADD CONSTRAINT "stalls_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stalls" DROP CONSTRAINT IF EXISTS "stalls_question_id_agent_questions_id_fk";--> statement-breakpoint
ALTER TABLE "stalls" ADD CONSTRAINT "stalls_question_id_agent_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."agent_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stalls_issue_idx" ON "stalls" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stalls_requirement_idx" ON "stalls" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stalls_feedback_idx" ON "stalls" USING btree ("feedback_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stalls_question_idx" ON "stalls" USING btree ("question_id");
