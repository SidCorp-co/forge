-- An issue names the patterns it builds to (REQ-36 BC-2, BC-3; Issue lifecycle r14 `design-check`).
-- A catalogued pattern is named as `reuse` and nobody decides it. An uncatalogued one is `new`: it
-- waits on one reviewer holding patterns.approve who did not name it, and while it waits the issue is
-- held out of dispatch (PATTERN_REVIEW_PENDING). The decision is taken once and stays; a returned
-- pattern stays as history, and naming the same slug again opens a new review. A retracted row stays.
-- `issue_pattern_guard()` refuses a write that re-aims a row, changes a decision or unretracts one.
--
-- ROLLBACK: DROP TABLE "issue_patterns"; DROP FUNCTION issue_pattern_guard(); every issue held by a
-- pending new pattern becomes dispatchable again, and the approvals recorded are gone.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE cascade,
	"pattern" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text,
	"named_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE restrict,
	"named_agency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision" text,
	"decided_by" uuid REFERENCES "users"("id") ON DELETE restrict,
	"decided_agency" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"retracted_by" uuid REFERENCES "users"("id") ON DELETE restrict,
	"retracted_at" timestamp with time zone,
	"retract_reason" text,
	CONSTRAINT "issue_patterns_pattern_chk" CHECK ("pattern" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "issue_patterns_kind_chk" CHECK ("kind" IN ('reuse', 'new')),
	CONSTRAINT "issue_patterns_summary_chk" CHECK ("summary" IS NULL OR length("summary") BETWEEN 1 AND 2000),
	CONSTRAINT "issue_patterns_new_summary_chk" CHECK ("kind" <> 'new' OR "summary" IS NOT NULL),
	CONSTRAINT "issue_patterns_decision_chk" CHECK ("decision" IS NULL OR ("kind" = 'new' AND "decision" IN ('approved', 'returned'))),
	CONSTRAINT "issue_patterns_decided_chk" CHECK (("decision" IS NULL) = ("decided_by" IS NULL) AND ("decision" IS NULL) = ("decided_at" IS NULL) AND ("decision" IS NULL) = ("decision_reason" IS NULL)),
	CONSTRAINT "issue_patterns_reason_chk" CHECK ("decision_reason" IS NULL OR length("decision_reason") BETWEEN 1 AND 2000),
	CONSTRAINT "issue_patterns_agency_chk" CHECK (("named_agency" IS NULL OR "named_agency" IN ('human', 'agent')) AND ("decided_agency" IS NULL OR "decided_agency" IN ('human', 'agent'))),
	CONSTRAINT "issue_patterns_retracted_chk" CHECK (("retracted_at" IS NULL) = ("retracted_by" IS NULL) AND ("retracted_at" IS NULL) = ("retract_reason" IS NULL)),
	CONSTRAINT "issue_patterns_retract_reason_chk" CHECK ("retract_reason" IS NULL OR length("retract_reason") BETWEEN 1 AND 2000)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_patterns_live_uq" ON "issue_patterns" ("issue_id", "pattern")
	WHERE "retracted_at" IS NULL AND "decision" IS DISTINCT FROM 'returned';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_patterns_issue_idx" ON "issue_patterns" ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_patterns_pending_idx" ON "issue_patterns" ("project_id", "issue_id")
	WHERE "kind" = 'new' AND "decision" IS NULL AND "retracted_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION issue_pattern_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM issues i WHERE i.id = NEW.issue_id AND i.project_id = NEW.project_id) THEN
      RAISE EXCEPTION 'ISSUE_PATTERN_PROJECT_MISMATCH: issue % is not in project %', NEW.issue_id, NEW.project_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.issue_id IS DISTINCT FROM OLD.issue_id
     OR NEW.pattern IS DISTINCT FROM OLD.pattern OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.named_by IS DISTINCT FROM OLD.named_by
     OR NEW.named_agency IS DISTINCT FROM OLD.named_agency OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ISSUE_PATTERN_IMMUTABLE: pattern % names its issue, slug and author once', OLD.id;
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.decided_agency IS DISTINCT FROM OLD.decided_agency OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
     OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'ISSUE_PATTERN_DECIDED_ONCE: pattern % was % and stays so', OLD.id, OLD.decision;
  END IF;
  IF OLD.retracted_at IS NOT NULL AND (NEW.retracted_at IS DISTINCT FROM OLD.retracted_at OR NEW.retract_reason IS DISTINCT FROM OLD.retract_reason
     OR NEW.retracted_by IS DISTINCT FROM OLD.retracted_by OR NEW.decision IS DISTINCT FROM OLD.decision) THEN
    RAISE EXCEPTION 'ISSUE_PATTERN_RETRACTED: pattern % was retracted and stays as it was', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "issue_patterns_guard_trg" ON "issue_patterns";--> statement-breakpoint
CREATE TRIGGER "issue_patterns_guard_trg" BEFORE INSERT OR UPDATE ON "issue_patterns"
  FOR EACH ROW EXECUTE FUNCTION issue_pattern_guard();
