-- A release approval says why the release may ship (REQ-34 r2 BC-25; Requirement lifecycle r15
-- release_check): the approver's reason is the release approval checklist's own question, so an
-- approved row now keeps it beside a returned one's.
--
-- release_approvals_reason_chk read "a reason exactly where returned", which refused an approval's
-- reason. It now reads: a pending request holds no reason, a return always holds one, and an
-- approval may. An approval decided before this migration holds none, and stays as it was decided:
-- the checklist that asks for one did not exist then. Every approval decided after it carries one,
-- which `release-batch/approvals.ts:decideApproval` refuses to write without.
--
-- ROLLBACK: put back the old check after clearing the reason of every approved row
-- (UPDATE release_approvals SET reason = NULL WHERE decision = 'approved'), which loses each
-- approver's stated reason.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "release_approvals" DROP CONSTRAINT IF EXISTS "release_approvals_reason_chk";--> statement-breakpoint
ALTER TABLE "release_approvals" ADD CONSTRAINT "release_approvals_reason_chk" CHECK (("release_approvals"."decision" IS NOT NULL OR "release_approvals"."reason" IS NULL) AND ("release_approvals"."decision" IS DISTINCT FROM 'returned' OR "release_approvals"."reason" IS NOT NULL));
