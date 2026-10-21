-- Feedback about Forge itself is filed by whoever reports it, from any project (REQ-47).
--   instance_settings     what this instance says about itself, one row at most; forge_home_project_id
--                         names the project that receives feedback about Forge. No row is written here:
--                         the home project is set by an instance admin, never guessed, and until it is
--                         set filing is refused FORGE_HOME_NOT_SET
--   feedback.signal_key   what a Forge-door report is about, so a later one naming it while the item is
--                         open is an occurrence of it, never a second item (BC-5)
--   feedback_occurrences  each report of an item through the Forge door: its reporter's own account and
--                         where it came from (project, issue, run, client version) (BC-2, BC-4)
-- The agent-report door is retired (BC-8): its token grant is renamed to the Forge door's
-- (`agent-reports:*` becomes `forge-feedback:*`, the door that replaces it), a pending chat write held
-- under the project door's old name `forge_feedback` is renamed `project_feedback` so agreeing to it
-- still records it, and agent_reports refuses a new row. The rows already there stay, read-only,
-- until the carry into Forge feedback has run; a later migration drops the table.
--
-- ROLLBACK: DROP TABLE feedback_occurrences, instance_settings; ALTER TABLE feedback DROP COLUMN
-- signal_key; DROP TRIGGER agent_reports_retired ON agent_reports; rewrite `forge-feedback:read` /
-- `forge-feedback:write` back to `agent-reports:*` in personal_access_tokens.permissions and
-- `project_feedback` back to `forge_feedback` in chat_proposals.call, with the code that names them.
--
-- A stored grant under `agent-reports` other than read or write aborts this migration naming it: the
-- menu never offered one, and once the word is gone it would grant nothing in silence.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"forge_home_project_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_settings_single_chk" CHECK ("instance_settings"."id" = 1),
	CONSTRAINT "instance_settings_revision_chk" CHECK ("instance_settings"."revision" >= 1)
);--> statement-breakpoint
ALTER TABLE "instance_settings" DROP CONSTRAINT IF EXISTS "instance_settings_forge_home_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_forge_home_project_id_projects_id_fk" FOREIGN KEY ("forge_home_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_settings" DROP CONSTRAINT IF EXISTS "instance_settings_updated_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN IF NOT EXISTS "signal_key" text;--> statement-breakpoint
ALTER TABLE "feedback" DROP CONSTRAINT IF EXISTS "feedback_signal_key_chk";--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_signal_key_chk" CHECK ("feedback"."signal_key" IS NULL OR "feedback"."signal_key" ~ '[^[:space:]]');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_project_signal_idx" ON "feedback" USING btree ("project_id","signal_key") WHERE signal_key IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feedback_id" uuid NOT NULL,
	"reported_by" uuid NOT NULL,
	"reporter_agency" text NOT NULL,
	"source_project_id" uuid,
	"source_issue_id" uuid,
	"source_run_id" uuid,
	"client_version" text,
	"dedup_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_occurrences_agency_chk" CHECK ("feedback_occurrences"."reporter_agency" IN ('human', 'agent'))
);--> statement-breakpoint
ALTER TABLE "feedback_occurrences" DROP CONSTRAINT IF EXISTS "feedback_occurrences_feedback_id_feedback_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD CONSTRAINT "feedback_occurrences_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" DROP CONSTRAINT IF EXISTS "feedback_occurrences_reported_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD CONSTRAINT "feedback_occurrences_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" DROP CONSTRAINT IF EXISTS "feedback_occurrences_source_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD CONSTRAINT "feedback_occurrences_source_project_id_projects_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" DROP CONSTRAINT IF EXISTS "feedback_occurrences_source_issue_id_issues_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD CONSTRAINT "feedback_occurrences_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_occurrences" DROP CONSTRAINT IF EXISTS "feedback_occurrences_source_run_id_pipeline_runs_id_fk";--> statement-breakpoint
ALTER TABLE "feedback_occurrences" ADD CONSTRAINT "feedback_occurrences_source_run_id_pipeline_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_occurrences_feedback_idx" ON "feedback_occurrences" USING btree ("feedback_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_occurrences_reporter_idx" ON "feedback_occurrences" USING btree ("reported_by");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feedback_occurrences_dedup_uq" ON "feedback_occurrences" USING btree ("dedup_key") WHERE dedup_key IS NOT NULL;--> statement-breakpoint
LOCK TABLE "personal_access_tokens" IN ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE bad text;
BEGIN
  SELECT g INTO bad FROM personal_access_tokens, unnest(permissions) g
  WHERE g LIKE 'agent-reports:%' AND g NOT IN ('agent-reports:read', 'agent-reports:write') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'PAT_GRANT_UNMAPPED: personal_access_tokens.permissions holds %; only agent-reports:read and agent-reports:write map to forge-feedback:*, so this migration writes nothing until it is repaired', bad USING ERRCODE = 'check_violation';
  END IF;
END $$;--> statement-breakpoint
UPDATE "personal_access_tokens"
SET "permissions" = array_replace(array_replace("permissions", 'agent-reports:read', 'forge-feedback:read'), 'agent-reports:write', 'forge-feedback:write')
WHERE "permissions" && ARRAY['agent-reports:read', 'agent-reports:write']::text[];--> statement-breakpoint
UPDATE "chat_proposals"
SET "call" = jsonb_set("call", '{name}', '"project_feedback"')
WHERE "form" = 'tool' AND "call" ->> 'name' = 'forge_feedback';--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_reports_retired() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AGENT_REPORTS_RETIRED: agent reports are retired (REQ-47 BC-8); feedback about Forge is filed through forge_feedback or POST /api/forge/feedback'
    USING ERRCODE = 'check_violation';
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_reports_retired" ON "agent_reports";--> statement-breakpoint
CREATE TRIGGER "agent_reports_retired" BEFORE INSERT ON "agent_reports" FOR EACH ROW EXECUTE FUNCTION agent_reports_retired();
