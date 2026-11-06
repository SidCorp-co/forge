-- An issue closes when its criteria are met in scope (ISS-1062; ADR 0014; owner, 2026-11-07): the
-- run holding it closes it, its merge recorded, once each criterion it did not meet is moved out on
-- the record. `closed` no longer says the work shipped: whether it is live is read from the release
-- record (`pipeline/release-runs.ts:shippedReleasesOf`), never from `closed`.
--
-- Two things change here, and no existing row does: every issue closed under the old rule keeps
-- what it holds, and every criterion keeps its row.
--
-- 1. Where a criterion the close did not meet went. A close moves it out before it closes
--    (`issues/close-in-scope.ts`): it is retired on the closing issue, naming the row it became on
--    the issue that took it on, or the requirement that holds it through the BC it traces. A
--    criterion names one destination at most, and only a retired one names any.
--
-- 2. The trigger holding the close to a recorded merge keeps its condition and changes its name
--    and its message: `closed` means its criteria were met in scope with its merge recorded, not
--    that the work shipped. Same transition-only shape as 0304, so no row standing in `closed`
--    without a merge is touched by a later write.
--
-- ROLLBACK: drop the two columns and the check; recreate 0304's function and triggers.

ALTER TABLE "issue_criteria" ADD COLUMN IF NOT EXISTS "moved_to_criterion_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_criteria" ADD COLUMN IF NOT EXISTS "moved_to_requirement_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_criteria_moved_to_criterion_fk') THEN
    ALTER TABLE "issue_criteria" ADD CONSTRAINT "issue_criteria_moved_to_criterion_fk"
      FOREIGN KEY ("moved_to_criterion_id") REFERENCES "issue_criteria"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_criteria_moved_to_requirement_fk') THEN
    ALTER TABLE "issue_criteria" ADD CONSTRAINT "issue_criteria_moved_to_requirement_fk"
      FOREIGN KEY ("moved_to_requirement_id") REFERENCES "requirements"("id") ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_criteria_moved_chk') THEN
    ALTER TABLE "issue_criteria" ADD CONSTRAINT "issue_criteria_moved_chk" CHECK (
      ("moved_to_criterion_id" IS NULL AND "moved_to_requirement_id" IS NULL)
      OR ("retired_at" IS NOT NULL AND ("moved_to_criterion_id" IS NULL OR "moved_to_requirement_id" IS NULL))
    );
  END IF;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION forge_closed_means_merged() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'closed' AND NEW.merged_at IS NULL THEN
    RAISE EXCEPTION
      'issue % (ISS-%) cannot enter `closed` with no merged_at. `closed` means its criteria were met in scope, with its merge recorded; whether the work is live is read from the release record. Record the merge first, or use `dropped` for work that turned out not to be work.',
      NEW.id, NEW.iss_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped ON issues;--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped_ins ON issues;--> statement-breakpoint
DROP FUNCTION IF EXISTS forge_closed_means_shipped();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_issues_closed_means_merged ON issues;--> statement-breakpoint
CREATE TRIGGER trg_issues_closed_means_merged
  BEFORE UPDATE ON issues
  FOR EACH ROW
  WHEN (
    NEW.status = 'closed' AND NEW.merged_at IS NULL
    AND (OLD.status IS DISTINCT FROM 'closed' OR OLD.merged_at IS NOT NULL)
  )
  EXECUTE FUNCTION forge_closed_means_merged();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_issues_closed_means_merged_ins ON issues;--> statement-breakpoint
CREATE TRIGGER trg_issues_closed_means_merged_ins
  BEFORE INSERT ON issues
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND NEW.merged_at IS NULL)
  EXECUTE FUNCTION forge_closed_means_merged();
