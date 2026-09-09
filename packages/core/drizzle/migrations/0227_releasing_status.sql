-- `releasing` — a release was triggered over this issue and is running.
--
-- Until now the in-flight fact lived only in `issues.release_batch_run_id`, so
-- `released` meant two things at once: waiting for a person to press the button,
-- and being released right now. No reader could tell them apart, and 16
-- `release_batch` jobs have run of which 4 failed and 2 were cancelled — exactly
-- the cases where the two readings diverge. `abortReleaseBatch` also clears the
-- column and leaves the status untouched, so a failed release is
-- indistinguishable from one never attempted.
--
-- `releasing` is the middle. `createReleaseBatch` writes it with the CAS claim,
-- `finish` moves it to `closed`, `abort` moves it to `reopen` with the reason.
-- Only those two write out of it, which is what stops an agent declaring its own
-- release finished (`release-gate-hold.ts`).
--
-- Additive, exactly as 0185 was for `dropped`: the retired values stay in the
-- list because historical rows still hold them. `released` stays for now — it is
-- drained in a later step, and freezing its writers before the drain is what
-- stops them refilling it.
--
-- Roll back: re-create the 0185 constraint (drop 'releasing' from the list).
-- No row can hold it before this migration runs.

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_chk;--> statement-breakpoint
ALTER TABLE issues ADD CONSTRAINT issues_status_chk
  CHECK (status IN (
    'open','confirmed','clarified','waiting','approved','in_progress','developed',
    'deploying','testing','tested','pass','staging','released','releasing',
    'closed','reopen','on_hold','needs_info','draft','dropped'
  ));
