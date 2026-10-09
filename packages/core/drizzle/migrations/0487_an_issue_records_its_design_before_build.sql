-- An issue records its design before build (REQ-36 BC-1, BC-13; Issue lifecycle r15 `design-check`).
-- `issue_designs` holds one design per issue: the module label ids and the `<project>/<contract>`
-- the change touches, who recorded it and its revision (each write replaces it whole and bumps it).
-- `issue_design_criteria` holds one line per live criterion: its class (observable on the running
-- build, or a code property), its catalogued pattern (null only where the project reads no catalog)
-- and its proof plan. A line is keyed by the criterion row, so a reworded or retired criterion takes
-- its line with it and the design check names what is missing. `design` joins the work steps between
-- plan and build. `criterion_verdicts.judge` says whether a verdict was recorded as QA's judgement
-- of the running build or as the review's; rows before this change keep it null.
--
-- ROLLBACK: DROP TABLE "issue_design_criteria"; DROP TABLE "issue_designs"; ALTER TABLE
-- "criterion_verdicts" DROP COLUMN "judge"; restore "issue_work_state_step_chk" without 'design'
-- after moving every row at step 'design' to 'plan'. The recorded designs and each verdict's judge
-- are lost, and nothing holds a move into build any more.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_designs" (
	"issue_id" uuid PRIMARY KEY NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"revision" integer NOT NULL,
	"modules" uuid[] NOT NULL,
	"contracts" text[] NOT NULL,
	"recorded_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"recorded_agency" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_designs_revision_chk" CHECK ("revision" >= 1),
	CONSTRAINT "issue_designs_modules_chk" CHECK (cardinality("modules") BETWEEN 1 AND 50),
	CONSTRAINT "issue_designs_contracts_chk" CHECK (cardinality("contracts") <= 50),
	CONSTRAINT "issue_designs_agency_chk" CHECK ("recorded_agency" IS NULL OR "recorded_agency" IN ('human', 'agent'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_designs_project_idx" ON "issue_designs" ("project_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_design_criteria" (
	"criterion_id" uuid PRIMARY KEY NOT NULL REFERENCES "issue_criteria"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issue_designs"("issue_id") ON DELETE cascade,
	"criterion_class" text NOT NULL,
	"pattern" text,
	"proof" text NOT NULL,
	CONSTRAINT "issue_design_criteria_class_chk" CHECK ("criterion_class" IN ('observable', 'code_property')),
	CONSTRAINT "issue_design_criteria_pattern_chk" CHECK ("pattern" IS NULL OR "pattern" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "issue_design_criteria_proof_chk" CHECK (length("proof") BETWEEN 1 AND 2000)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_design_criteria_issue_idx" ON "issue_design_criteria" ("issue_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION issue_design_guard() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'issue_designs' THEN
    IF NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = NEW.issue_id AND i.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'ISSUE_DESIGN_PROJECT_MISMATCH: issue % is not in project %', NEW.issue_id, NEW.project_id;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM issue_criteria c WHERE c.id = NEW.criterion_id AND c.issue_id = NEW.issue_id) THEN
    RAISE EXCEPTION 'ISSUE_DESIGN_CRITERION_MISMATCH: criterion % is not a criterion of issue %', NEW.criterion_id, NEW.issue_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "issue_designs_guard_trg" ON "issue_designs";--> statement-breakpoint
CREATE TRIGGER "issue_designs_guard_trg" BEFORE INSERT OR UPDATE ON "issue_designs"
  FOR EACH ROW EXECUTE FUNCTION issue_design_guard();--> statement-breakpoint
DROP TRIGGER IF EXISTS "issue_design_criteria_guard_trg" ON "issue_design_criteria";--> statement-breakpoint
CREATE TRIGGER "issue_design_criteria_guard_trg" BEFORE INSERT OR UPDATE ON "issue_design_criteria"
  FOR EACH ROW EXECUTE FUNCTION issue_design_guard();--> statement-breakpoint
ALTER TABLE "issue_work_state" DROP CONSTRAINT IF EXISTS "issue_work_state_step_chk";--> statement-breakpoint
ALTER TABLE "issue_work_state" ADD CONSTRAINT "issue_work_state_step_chk" CHECK ("step" IS NULL OR "step" IN ('triage', 'clarify', 'plan', 'design', 'build', 'test', 'release'));--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD COLUMN IF NOT EXISTS "judge" text;--> statement-breakpoint
ALTER TABLE "criterion_verdicts" DROP CONSTRAINT IF EXISTS "criterion_verdicts_judge_chk";--> statement-breakpoint
ALTER TABLE "criterion_verdicts" ADD CONSTRAINT "criterion_verdicts_judge_chk" CHECK ("judge" IS NULL OR "judge" IN ('qa', 'review'));
