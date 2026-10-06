-- A holder of feedback.approve corrects what a feedback item is about (ISS-264), and the move is kept
-- as its own decision row, `retargeted`, naming the target it replaced. The decision check is rebuilt
-- from the contract's list with that one value added. It only widens, so no stored row falls outside it.
--
-- ROLLBACK: keep it. A `retargeted` row is the only record of an item's earlier target, so the value
--           is never narrowed out while a row holds it; an item's move is undone by hand from that row.

ALTER TABLE "feedback_decisions" DROP CONSTRAINT "feedback_decisions_decision_chk";--> statement-breakpoint
ALTER TABLE "feedback_decisions" ADD CONSTRAINT "feedback_decisions_decision_chk" CHECK ("feedback_decisions"."decision" IN ('triaged', 'declined', 'verified', 'reopened', 'redacted', 'promoted', 'routed', 'retargeted'));
