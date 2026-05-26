-- ISS-236 — establish issues_status_chk as defence-in-depth matching the
-- Drizzle TS enum (issueStatuses). The 'draft' value lets AI schedules
-- (Dream / Doc-Sync) deposit proposal issues that wait for human review.
-- No existing constraint to drop — this is the first issues_status_chk.
ALTER TABLE issues ADD CONSTRAINT issues_status_chk
  CHECK (status IN (
    'open','confirmed','waiting','approved','in_progress','developed',
    'deploying','testing','tested','pass','staging','released',
    'closed','reopen','on_hold','needs_info','draft'
  ));
