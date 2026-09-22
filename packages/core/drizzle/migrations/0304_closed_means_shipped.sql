-- ISS-1108 — `closed` means the work shipped, and nothing else.
--
-- `closed` carried two meanings and only `merged_at` separated them: the
-- shipped terminal, and where an issue went that turned out not to be work.
-- The documented route for the second was `closed` followed by
-- `forge_issues action=unmark`, because the close auto-stamped `merged_at`
-- itself. Get the order wrong and the row reads as delivered forever, and
-- `closed_unshipped` existed as a state a row could fall into by accident.
--
-- The owner's decision, 2026-09-20: `closed` always means shipped. Work that is
-- not work leaves by `dropped`, which already expires the dropped issue's
-- `blocks` edges (`issues/drop-cascade.ts`) and already leaves `merged_at`
-- null.
--
-- `issues/apply-transition.ts` refuses such a close by name and in the
-- application. This is the half that holds whatever wrote the row.

-- ── The existing rows decide this migration, not the other way round ─────────
-- A `closed` row with no `merged_at` cannot be represented under the new
-- meaning. It is named and the migration aborts; it is NOT stamped, NOT dropped
-- and NOT cleaned away so the DDL below can succeed. Whoever owns that row
-- decides whether it shipped (mark it) or never did (move it to `dropped`), and
-- this deploy waits for them.
--
-- The count should be small: the close has been stamping since 0185, so the
-- only way to reach this state is an `unmark` after a close. It is counted
-- rather than assumed, because "should be" is not a reading.
DO $$
DECLARE
  offending record;
  total int;
BEGIN
  SELECT count(*) INTO total FROM issues WHERE status = 'closed' AND merged_at IS NULL;
  IF total > 0 THEN
    SELECT id, iss_seq, project_id, title
      INTO offending
      FROM issues
     WHERE status = 'closed' AND merged_at IS NULL
     ORDER BY updated_at
     LIMIT 1;
    RAISE EXCEPTION
      'ISS-1108: % issue row(s) read `closed` with no merged_at, and `closed` now means the work shipped. The oldest is % (ISS-%, project %): "%". Decide what each one is before this migration runs — mark it merged if it shipped, or move it to `dropped` if it did not. Nothing was changed.',
      total, offending.id, offending.iss_seq, offending.project_id, offending.title;
  END IF;
  RAISE NOTICE 'ISS-1108: 0 closed row(s) without merged_at; every closed issue can show it shipped.';
END $$;--> statement-breakpoint

-- Everything below this line changes the schema. The check that could refuse
-- has already run.

-- ── The rule, held by the database ──────────────────────────────────────────
-- A trigger and not a CHECK constraint, because the refusal IS the deliverable:
-- a constraint violation names the constraint and leaves the reader to find out
-- what it meant, while this names the issue, the rule and the exit. It also
-- keeps the migration free of schema DDL, so the journal's snapshot chain is
-- unchanged.
--
-- BEFORE UPDATE rather than AFTER, so the write never lands.
CREATE OR REPLACE FUNCTION forge_closed_means_shipped() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'closed' AND NEW.merged_at IS NULL THEN
    RAISE EXCEPTION
      'ISS-1108: issue % (ISS-%) cannot enter `closed` with no merged_at. `closed` means the work shipped; mark the merge first, or use `dropped` for work that turned out not to be work.',
      NEW.id, NEW.iss_seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped ON issues;--> statement-breakpoint
CREATE TRIGGER trg_issues_closed_means_shipped
  BEFORE UPDATE ON issues
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND NEW.merged_at IS NULL)
  EXECUTE FUNCTION forge_closed_means_shipped();--> statement-breakpoint

-- The same rule on the way in. A row created `closed` would otherwise reach the
-- state the UPDATE trigger exists to refuse, and "no way to reach it" has to
-- mean every way.
DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped_ins ON issues;--> statement-breakpoint
CREATE TRIGGER trg_issues_closed_means_shipped_ins
  BEFORE INSERT ON issues
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND NEW.merged_at IS NULL)
  EXECUTE FUNCTION forge_closed_means_shipped();
