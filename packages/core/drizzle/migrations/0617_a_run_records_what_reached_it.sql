-- ISS-1065 — core records each rule, knowledge entry, lesson and memory that reached a run session:
-- composed into its prompt or orientation, or returned by a knowledge get or a knowledge or memory
-- search its credential made. One row per reach (what, how, when), owned by `run-context`
-- (`packages/core/src/db/schema-run-context.ts:runContextReaches`), so a wrong action can be traced
-- to the text the agent was given.
--
-- A new table: nothing already written is touched, and no row is backfilled, because what reached a
-- run before this landed was never recorded and cannot be recovered.
--
-- ROLLBACK: DROP TABLE IF EXISTS "run_context_reaches";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_context_reaches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_session_id" uuid NOT NULL,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"revision" text,
	"how" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_context_reaches_kind_chk" CHECK ("run_context_reaches"."kind" IN ('rule', 'knowledge', 'lesson', 'memory')),
	CONSTRAINT "run_context_reaches_how_chk" CHECK ("run_context_reaches"."how" IN ('prompt', 'get', 'search'))
);--> statement-breakpoint
ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD CONSTRAINT "run_context_reaches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_agent_session_id_agent_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD CONSTRAINT "run_context_reaches_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD CONSTRAINT "run_context_reaches_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_context_reaches_session_idx" ON "run_context_reaches" USING btree ("agent_session_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_context_reaches_issue_idx" ON "run_context_reaches" USING btree ("issue_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_context_reaches_project_idx" ON "run_context_reaches" USING btree ("project_id");
