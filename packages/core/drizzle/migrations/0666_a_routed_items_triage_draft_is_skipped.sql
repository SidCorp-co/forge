-- ISS-596 c6: a filed item's triage draft is skipped `triage_taken` where the item was routed before
-- the draft's job could start (`steward/subjects.ts:triageTaken`), instead of spending a job of its
-- project's one slot to write nothing, unsaid on the item (FB-641..645, 2026-11-16 00:20Z).
--
-- WHAT CHANGES. `steward_runs_skip_reason_chk` admits the new reason beside the four it held. No row
-- is rewritten: a run skipped before reads as it did.
--
-- ROLLBACK: drop the constraint and add it back without 'triage_taken', once no run holds it.
ALTER TABLE "steward_runs" DROP CONSTRAINT "steward_runs_skip_reason_chk";--> statement-breakpoint
ALTER TABLE "steward_runs" ADD CONSTRAINT "steward_runs_skip_reason_chk" CHECK ("steward_runs"."skip_reason" IS NULL OR "steward_runs"."skip_reason" IN ('basis_unchanged', 'budget_spent', 'steward_off', 'subject_ended', 'triage_taken'));
