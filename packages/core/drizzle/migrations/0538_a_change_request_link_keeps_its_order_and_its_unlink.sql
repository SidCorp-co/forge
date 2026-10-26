-- ISS-705 (FB-295, REQ-63 BC-4): a change request links the issues it delivers, its branch issue
-- first, and a person can take a stray link off it.
--
-- `repo_pull_request_issues.position` is the order the request names its issues in: branch keys
-- first, then the keys its description delivers, as written. The primary linked issue is the first.
-- Until now the links were read back by `created_at` and then by issue uuid, and one delivery writes
-- every link in one statement, so the "primary" was whichever uuid sorted lowest (ISS-11 on !1979,
-- not the branch's ISS-37). Existing rows are numbered branch links first, then by issue number,
-- which is the order the resolver returned them in when they were written.
--
-- `repo_pull_request_issue_unlinks` keeps a person's unlink of one issue from one request, with who
-- did it and the kind the link had. Each delivery rewrites the links whole from the branch and the
-- description, so without it the next delivery would put the stray link straight back. A relink
-- records itself on the same row (`relinked_at`); the unlink stands while `relinked_at` is null.
--
-- ROLLBACK: drop `repo_pull_request_issue_unlinks` (every unlink is lost and the next delivery of
-- each request relinks what it names) and drop `repo_pull_request_issues.position` (the primary goes
-- back to the lowest uuid).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "repo_pull_request_issues" ADD COLUMN IF NOT EXISTS "position" integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE "repo_pull_request_issues" l
   SET "position" = n.pos
  FROM (
    SELECT x."pull_request_id", x."issue_id",
           (row_number() OVER (
              PARTITION BY x."pull_request_id"
              ORDER BY (x."linked_by" = 'head-ref') DESC, i."iss_seq", x."issue_id"
            ) - 1)::integer AS pos
      FROM "repo_pull_request_issues" x
      JOIN "issues" i ON i."id" = x."issue_id"
  ) n
 WHERE l."pull_request_id" = n."pull_request_id" AND l."issue_id" = n."issue_id"
   AND l."position" <> n.pos;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repo_pull_request_issue_unlinks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pull_request_id" uuid NOT NULL REFERENCES "repo_pull_requests"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "linked_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "unlinked_at" timestamp with time zone NOT NULL,
  "unlinked_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "unlinked_agency" text NOT NULL,
  "relinked_at" timestamp with time zone,
  "relinked_by" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  "relinked_agency" text,
  CONSTRAINT "repo_pull_request_issue_unlinks_linked_by_chk" CHECK (linked_by IN ('head-ref', 'description')),
  CONSTRAINT "repo_pull_request_issue_unlinks_unlinked_agency_chk" CHECK (unlinked_agency IN ('human', 'agent')),
  CONSTRAINT "repo_pull_request_issue_unlinks_relinked_agency_chk" CHECK (relinked_agency IS NULL OR relinked_agency IN ('human', 'agent'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repo_pull_request_issue_unlinks_pr_issue_uq" ON "repo_pull_request_issue_unlinks" ("pull_request_id", "issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repo_pull_request_issue_unlinks_issue_idx" ON "repo_pull_request_issue_unlinks" ("issue_id");
