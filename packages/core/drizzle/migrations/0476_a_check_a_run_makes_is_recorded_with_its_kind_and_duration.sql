-- Every check a run makes is recorded on its issue with its kind and its duration (REQ-36 BC-14;
-- Issue to release r20 `act-build`, `rule-merge`; ISS-474), so the time spent per kind of check is
-- shown per issue. The script that ran a check timed it and gave it its id; core keeps it once, on
-- the run session holding the issue on the box that sent it (null for a call from no run). The merge
-- check's checks are rows here too (`via` 'merge-check'), so its verification record no longer
-- carries a second copy of each duration. `issue_check_run_guard()` refuses every UPDATE: a timed
-- check is written once, and leaves only with its issue.
--
-- ROLLBACK: DROP TABLE "issue_check_runs"; DROP FUNCTION issue_check_run_guard(); the issue page then
-- shows no check time, and the merge check's verification records written since name their checks
-- without their durations, which are gone.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_check_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"command" text NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"head_sha" text NOT NULL,
	"note" text,
	"run_session_id" uuid,
	"via" text NOT NULL,
	"recorded_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"recorded_agency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_check_runs_kind_chk" CHECK ("kind" IN ('tests', 'typecheck', 'probes', 'review', 'conformance', 'base')),
	CONSTRAINT "issue_check_runs_result_chk" CHECK ("result" IN ('pass', 'fail', 'none')),
	CONSTRAINT "issue_check_runs_via_chk" CHECK ("via" IN ('report', 'merge-check')),
	CONSTRAINT "issue_check_runs_duration_chk" CHECK ("duration_ms" >= 0),
	CONSTRAINT "issue_check_runs_head_chk" CHECK ("head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "issue_check_runs_files_chk" CHECK (jsonb_typeof("files") = 'array'),
	CONSTRAINT "issue_check_runs_agency_chk" CHECK ("recorded_agency" IS NULL OR "recorded_agency" IN ('human', 'agent'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_check_runs_issue_idx" ON "issue_check_runs" ("issue_id", "started_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION issue_check_run_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ISSUE_CHECK_RUN_IMMUTABLE: check % was recorded once and stays as it was', OLD.id;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "issue_check_runs_guard_trg" ON "issue_check_runs";--> statement-breakpoint
CREATE TRIGGER "issue_check_runs_guard_trg" BEFORE UPDATE ON "issue_check_runs"
	FOR EACH ROW EXECUTE FUNCTION issue_check_run_guard();
