-- `dropped` — closed, but the work never happened (agent-driven pipeline, 4).
--
-- Closing an issue stamps `merged_at`, which unblocks every `blocks` dependent
-- as if the work had shipped. When the issue turns out NOT to be work — a
-- duplicate, a question, a note — the correct sequence today is close THEN
-- `forge_issues unmark`, and the second step is the one that gets forgotten.
-- A forgotten unmark is not visible: the dependents simply dispatch.
--
-- `dropped` makes it one step. It is terminal for dispatch and it closes the
-- run exactly like `closed`, but `markMergedOnClose` only ever fires for
-- `closed`, so a dropped issue leaves `merged_at` NULL and its dependents
-- stay blocked until a human decides otherwise. That is the intended outcome,
-- not an omission.
--
-- The CHECK is a defence-in-depth mirror of the Drizzle TS enum (established
-- by 0079, last restated by 0093). The retired values are kept in the list
-- because historical rows may still hold them; adding one is additive.
--
-- Roll back: re-create the 0093 constraint (drop 'dropped' from the list).
-- No row can hold it before this migration runs.

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_chk;--> statement-breakpoint
ALTER TABLE issues ADD CONSTRAINT issues_status_chk
  CHECK (status IN (
    'open','confirmed','clarified','waiting','approved','in_progress','developed',
    'deploying','testing','tested','pass','staging','released',
    'closed','reopen','on_hold','needs_info','draft','dropped'
  ));
