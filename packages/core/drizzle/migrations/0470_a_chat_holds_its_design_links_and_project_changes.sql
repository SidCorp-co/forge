-- A chat's design link and its project change wait for the person's agreement too (ISS-439 round 2,
-- REQ-30 BC-4). An Agent session linked a design to a requirement and changed a project with no
-- card, and the Assistant's `forge project --set` was not classed as a write. Both are now held as
-- proposals, of two kinds the table did not name: requirement_link and project_change. Only the
-- kind check widens; every row already stored holds one of the nine kinds it keeps, so none can
-- fail it.
--
-- ROLLBACK: restore the nine-kind check, after deleting any row of kind requirement_link or
-- project_change (those proposals then no longer exist to decide).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "chat_proposals" DROP CONSTRAINT IF EXISTS "chat_proposals_kind_chk";--> statement-breakpoint
ALTER TABLE "chat_proposals" ADD CONSTRAINT "chat_proposals_kind_chk" CHECK ("chat_proposals"."kind" IN ('feedback', 'requirement_draft', 'requirement_revision', 'comment', 'attachment', 'memory_note', 'preferences', 'report_save', 'issue_change', 'requirement_link', 'project_change'));
