-- A new pattern is decided by one reviewer, never the run that wrote it (REQ-36 BC-2; Issue
-- lifecycle r14 `design-check`). Runs on one box share one account, so the account cannot tell them
-- apart: a row now names the run session that named it and the one that decided it. A person's
-- write names no session. Both are written once; `issue_pattern_guard()` keeps them so.
--
-- No FK on either column: a cascade that nulled one would be an UPDATE the guard refuses, and a
-- session goes only with its project, which takes these rows with it.
--
-- ROLLBACK: ALTER TABLE "issue_patterns" DROP COLUMN "named_session_id", DROP COLUMN
-- "decided_session_id", and restore 0474's issue_pattern_guard(). The author rule then compares
-- accounts again, and no run sharing a box account can decide another's pattern.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issue_patterns" ADD COLUMN IF NOT EXISTS "named_session_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_patterns" ADD COLUMN IF NOT EXISTS "decided_session_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_patterns" DROP CONSTRAINT IF EXISTS "issue_patterns_decided_session_chk";--> statement-breakpoint
ALTER TABLE "issue_patterns" ADD CONSTRAINT "issue_patterns_decided_session_chk" CHECK ("decided_session_id" IS NULL OR "decision" IS NOT NULL);--> statement-breakpoint
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
     OR NEW.named_agency IS DISTINCT FROM OLD.named_agency OR NEW.named_session_id IS DISTINCT FROM OLD.named_session_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ISSUE_PATTERN_IMMUTABLE: pattern % names its issue, slug and author once', OLD.id;
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
     OR NEW.decided_agency IS DISTINCT FROM OLD.decided_agency OR NEW.decided_session_id IS DISTINCT FROM OLD.decided_session_id
     OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason) THEN
    RAISE EXCEPTION 'ISSUE_PATTERN_DECIDED_ONCE: pattern % was % and stays so', OLD.id, OLD.decision;
  END IF;
  IF OLD.retracted_at IS NOT NULL AND (NEW.retracted_at IS DISTINCT FROM OLD.retracted_at OR NEW.retract_reason IS DISTINCT FROM OLD.retract_reason
     OR NEW.retracted_by IS DISTINCT FROM OLD.retracted_by OR NEW.decision IS DISTINCT FROM OLD.decision) THEN
    RAISE EXCEPTION 'ISSUE_PATTERN_RETRACTED: pattern % was retracted and stays as it was', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
