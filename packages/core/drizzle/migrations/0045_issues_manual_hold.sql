-- ISS-42 C1 — manual hold flag on issues. When true, the dispatcher's Layer 1
-- short-circuits with reason 'manual_hold' so no new pipeline jobs are
-- enqueued for this issue. Existing in-flight jobs are not killed.
ALTER TABLE issues ADD COLUMN manual_hold boolean NOT NULL DEFAULT false;
CREATE INDEX issues_manual_hold_idx ON issues(manual_hold) WHERE manual_hold = true;
