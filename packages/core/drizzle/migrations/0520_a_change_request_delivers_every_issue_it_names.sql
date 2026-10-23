-- REQ-63: a release can be the go to merge a project's change requests, in order.
--
-- BC-4: one change request delivers every issue its branch or its description names. The single
-- `repo_pull_requests.issue_id` could hold one, so a merge request carrying eight issues stamped one
-- of them and the merge route found none of the other seven. `repo_pull_request_issues` holds one row
-- per issue a request delivers; every link `issue_id` held moves into it as a `head-ref` link (that
-- column was only ever written from the branch name), and the column goes, so nothing reads two
-- answers to the question.
--
-- The approval of a change-request release rests on its requests' heads, not on a reading from an
-- environment, so `release_approvals.evidence_environment` admits null. Every stored row keeps its
-- environment.
--
-- ROLLBACK: add `repo_pull_requests.issue_id uuid REFERENCES issues(id) ON DELETE SET NULL` and its
-- index, set it from the `head-ref` link of each request (one per request: the oldest), drop
-- `repo_pull_request_issues`; set `evidence_environment` NOT NULL once no row holds null.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_pull_request_issues" (
  "pull_request_id" uuid NOT NULL REFERENCES "repo_pull_requests"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "linked_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "repo_pull_request_issues_pk" PRIMARY KEY ("pull_request_id", "issue_id"),
  CONSTRAINT "repo_pull_request_issues_linked_by_chk" CHECK (linked_by IN ('head-ref', 'description'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_pull_request_issues_issue_idx" ON "repo_pull_request_issues" ("issue_id");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'repo_pull_requests' AND column_name = 'issue_id'
  ) THEN
    INSERT INTO "repo_pull_request_issues" ("pull_request_id", "issue_id", "linked_by")
    SELECT "id", "issue_id", 'head-ref' FROM "repo_pull_requests" WHERE "issue_id" IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "repo_pull_requests_issue_idx";--> statement-breakpoint
ALTER TABLE "repo_pull_requests" DROP COLUMN IF EXISTS "issue_id";--> statement-breakpoint
ALTER TABLE "release_approvals" ALTER COLUMN "evidence_environment" DROP NOT NULL;
