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

-- ── The rule governs the TRANSITION, so the existing rows do not decide it ───
-- Nothing below adds a column, validates a constraint or backfills a value, so
-- every row already in the table is representable under the new meaning whatever
-- it holds. A row that reads `closed` with no `merged_at` is therefore counted
-- and named, and the migration carries on: it is NOT stamped, NOT dropped and
-- NOT cleaned away, because each of those invents a decision about work nobody
-- here made.
--
-- This block used to RAISE EXCEPTION on that count. The premise stated beside it
-- was that the close has been stamping since 0185, so only an `unmark` after a
-- close could reach the state and the count would be small. The premise was
-- wrong: the count on forge-beta is 597, the oldest being ISS-1 of another
-- project, and there is a whole population of closes predating the stamping that
-- was never one-by-one decidable. Because `dist/db/migrate.js` runs before the
-- server in the same container command, the abort stopped the API booting rather
-- than stopping a bad write.
--
-- The count stays a NOTICE rather than being dropped, so the size of that
-- population is on the record at every deploy instead of vanishing.
DO $$
DECLARE
  offending record;
  total int;
BEGIN
  SELECT count(*) INTO total FROM issues WHERE status = 'closed' AND merged_at IS NULL;
  IF total = 0 THEN
    RAISE NOTICE 'ISS-1108: 0 closed row(s) without merged_at; every closed issue can show it shipped.';
  ELSE
    SELECT id, iss_seq, project_id, title
      INTO offending
      FROM issues
     WHERE status = 'closed' AND merged_at IS NULL
     ORDER BY updated_at
     LIMIT 1;
    RAISE NOTICE
      'ISS-1108: % issue row(s) read `closed` with no merged_at and predate this rule. The oldest is % (ISS-%, project %): "%". They keep the state the forward rule forbids and nothing here changes them — whoever owns each row decides whether it shipped (mark it merged) or never did (move it to `dropped`). The rule below governs the transition, so none of them can be reached again from outside this state.',
      total, offending.id, offending.iss_seq, offending.project_id, offending.title;
  END IF;
END $$;--> statement-breakpoint

-- ── The rule, held by the database ──────────────────────────────────────────
-- A trigger and not a CHECK constraint, because the refusal IS the deliverable:
-- a constraint violation names the constraint and leaves the reader to find out
-- what it meant, while this names the issue, the rule and the exit. A CHECK
-- would also be the wrong shape twice over — it measures the row's state rather
-- than the transition into it, so it would refuse every later write to a legacy
-- row. It keeps the migration free of schema DDL either way, so the journal's
-- snapshot chain is unchanged.
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
-- The third conjunct is what makes this a rule about the transition. Without it
-- the trigger fires on ANY update to a row already standing in the forbidden
-- state — a title, a touched `updated_at`, a relation — and the 597 legacy rows
-- become permanently un-updatable, refused by a message naming a close nobody
-- attempted. With it, a row only meets the rule on the way IN: entering `closed`
-- from anywhere else, or having its claim cleared while it stands there.
CREATE TRIGGER trg_issues_closed_means_shipped
  BEFORE UPDATE ON issues
  FOR EACH ROW
  WHEN (
    NEW.status = 'closed' AND NEW.merged_at IS NULL
    AND (OLD.status IS DISTINCT FROM 'closed' OR OLD.merged_at IS NOT NULL)
  )
  EXECUTE FUNCTION forge_closed_means_shipped();--> statement-breakpoint

-- The same rule on the way in. A row created `closed` would otherwise reach the
-- state the UPDATE trigger exists to refuse, and "no way to reach it" has to
-- mean every way. No narrowing here: an INSERT has no prior state to be already
-- standing in.
DROP TRIGGER IF EXISTS trg_issues_closed_means_shipped_ins ON issues;--> statement-breakpoint
CREATE TRIGGER trg_issues_closed_means_shipped_ins
  BEFORE INSERT ON issues
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND NEW.merged_at IS NULL)
  EXECUTE FUNCTION forge_closed_means_shipped();
