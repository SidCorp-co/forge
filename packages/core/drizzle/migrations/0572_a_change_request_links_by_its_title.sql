-- A change request delivers the issues its title leads with or lists, as well as its branch's and
-- its description's (REQ-63 BC-4 r10, ISS-855): a link and an unlink may now record `title` as how
-- the request came to deliver the issue. Every existing row stays as written.
--
-- ROLLBACK: delete the `title` rows' links (the next delivery re-derives them) and restore the
-- two-kind checks.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "repo_pull_request_issues" DROP CONSTRAINT IF EXISTS "repo_pull_request_issues_linked_by_chk";--> statement-breakpoint
ALTER TABLE "repo_pull_request_issues" ADD CONSTRAINT "repo_pull_request_issues_linked_by_chk" CHECK (linked_by IN ('head-ref', 'title', 'description'));--> statement-breakpoint
ALTER TABLE "repo_pull_request_issue_unlinks" DROP CONSTRAINT IF EXISTS "repo_pull_request_issue_unlinks_linked_by_chk";--> statement-breakpoint
ALTER TABLE "repo_pull_request_issue_unlinks" ADD CONSTRAINT "repo_pull_request_issue_unlinks_linked_by_chk" CHECK (linked_by IN ('head-ref', 'title', 'description'));
