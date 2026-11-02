-- A person's act a project's own rule names gets a Forge route on any gate profile (ISS-869).
--
-- A question may name the project rule that asks for a person's act: such a question is that
-- person's on any profile, so an agent's ask of a person is admitted by the project's own rule, and
-- an agent's answer or void of it is refused. Null on every question written before.
--
-- A drafted release on a project that declares no production is decided by its listed approvers,
-- keyed on its version, since no run is cut to ask approval on: one row per decision, the roster it
-- was given on beside it. No commit is recorded (release-is-the-agents-record).
--
-- ROLLBACK: DROP TABLE IF EXISTS "release_draft_approvals";
--           ALTER TABLE "agent_questions" DROP COLUMN IF EXISTS "rule";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN IF NOT EXISTS "rule" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "release_draft_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"version" text NOT NULL,
	"issue_ids" jsonb NOT NULL,
	"decision" text NOT NULL,
	"decided_by_user" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "release_draft_approvals_decision_chk" CHECK ("decision" IN ('approved', 'returned')),
	CONSTRAINT "release_draft_approvals_reason_chk" CHECK ("decision" <> 'returned' OR "reason" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_draft_approvals_version_idx" ON "release_draft_approvals" USING btree ("project_id", "version", "decided_at");
