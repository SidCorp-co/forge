-- A check seen only inside the running server is a criterion class of its own (REQ-36 BC-21):
-- `server_side` joins `observable` and `code_property` on an issue's design line. QA judges it from
-- a capture attached to the issue; it owes no screen clip and keeps no replayed probe, which the
-- verdict door decides (`issues/criteria/clip-citation.ts`, `probe-rules.ts`), not this table.
-- No row is rewritten: every line already held keeps the class it was designed with.
--
-- ROLLBACK: a design line classed server_side has no older class to go back to, so reclass those
-- lines first (PUT /api/issues/:id/design), then restore the two-class CHECK below.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issue_design_criteria" DROP CONSTRAINT IF EXISTS "issue_design_criteria_class_chk";--> statement-breakpoint
ALTER TABLE "issue_design_criteria" ADD CONSTRAINT "issue_design_criteria_class_chk" CHECK ("criterion_class" IN ('observable', 'code_property', 'server_side'));
