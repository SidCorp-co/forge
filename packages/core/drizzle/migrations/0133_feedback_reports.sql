-- ISS-552 (C1) — append-only agent friction feed table.
-- Agents submit friction, skill gaps, learnings mid-run so owners can read
-- the raw feed before the normalizer (C2) accrues signals into candidates.
-- candidate_id is column-only (no FK) until C2 creates memory_candidates.

CREATE TABLE IF NOT EXISTS "feedback_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "issue_id" uuid,
  "run_id" uuid,
  "job_id" uuid,
  "stage" text,
  "skill_name" text,
  "skill_version" integer,
  "kind" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'low',
  "target" text NOT NULL,
  "target_ref" text,
  "summary" text NOT NULL,
  "detail" text,
  "suggestion" text,
  "candidate_id" uuid,
  "signal_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- FK: project_id → projects.id (cascade delete)
DO $$ BEGIN
  ALTER TABLE "feedback_reports"
    ADD CONSTRAINT "feedback_reports_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- FK: issue_id → issues.id (set null)
DO $$ BEGIN
  ALTER TABLE "feedback_reports"
    ADD CONSTRAINT "feedback_reports_issue_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- FK: run_id → pipeline_runs.id (set null)
DO $$ BEGIN
  ALTER TABLE "feedback_reports"
    ADD CONSTRAINT "feedback_reports_run_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "pipeline_runs"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- FK: job_id → jobs.id (set null)
DO $$ BEGIN
  ALTER TABLE "feedback_reports"
    ADD CONSTRAINT "feedback_reports_job_id_fk"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "feedback_reports_project_id_idx"
  ON "feedback_reports" ("project_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "feedback_reports_project_kind_idx"
  ON "feedback_reports" ("project_id", "kind");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "feedback_reports_project_target_idx"
  ON "feedback_reports" ("project_id", "target", "target_ref");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "feedback_reports_signal_key_idx"
  ON "feedback_reports" ("signal_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "feedback_reports_created_at_idx"
  ON "feedback_reports" ("created_at");
