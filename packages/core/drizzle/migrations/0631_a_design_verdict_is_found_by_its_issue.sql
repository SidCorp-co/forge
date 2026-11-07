-- Whether an issue's criteria name a design is found by the issue, through the verdicts that name
-- one, before any criterion's newest verdict is read (`issues/design-delivery.ts:deliveredBy`,
-- ISS-1070 r6). The design-holds read walked every criterion's newest verdict of every asked issue,
-- 1316 buffers for 64 open issues, to find none; an issue no design verdict names is now passed over
-- on this index alone, and few verdicts name a design.
--
-- ROLLBACK: DROP INDEX IF EXISTS criterion_verdicts_design_issue_idx;
CREATE INDEX IF NOT EXISTS "criterion_verdicts_design_issue_idx"
  ON "criterion_verdicts" ("issue_id") WHERE "identity_kind" = 'design';
