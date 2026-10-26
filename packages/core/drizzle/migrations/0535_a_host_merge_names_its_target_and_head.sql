-- A host merge names the branch it landed on and the head it merged (2026-10-26, adminhub-api ISS-1,
-- catalog-fe ISS-11..19, ISS-23).
--
-- issues.merged_head: the merged change request's head and whether Forge read from the host, at the
-- merge, that its tree is the landing commit's tree (`@forge/contracts/landing-artifacts:MergedHead`).
-- A verdict judged at that head counts for the landing only where treeIdentical is true. It needs an
-- observed commit beside it (issues_merged_head_chk).
--
-- Backfilled, from Forge's projection of the host (`repo_pull_requests`, `repo_pull_request_issues`):
-- 1. An issue linked to several merged requests whose stamp is the merge commit of one of them, and a
--    later linked request merged after it, lands at the last (an issue delivered across several
--    requests lands at the last one that delivered it): merged_at and merged_commit_sha move to that
--    request's merge; merged_head is left NULL (the trees were not read at that merge).
-- 2. An issue whose merged_commit_sha is the merge commit of a merged request takes that request's
--    base_ref as merged_target, replacing a NULL the merge route left and a mark's word written
--    beside it (the route stamped no target; a later mark's `target` filled the empty column).
-- Every other row is unchanged.
--
-- ROLLBACK: ALTER TABLE issues DROP CONSTRAINT issues_merged_head_chk, DROP COLUMN merged_head,
-- losing every head reading. The backfilled targets and moved stamps are not restored: the values
-- they replaced were not what the host recorded.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "merged_head" jsonb;--> statement-breakpoint
ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "issues_merged_head_chk";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_merged_head_chk" CHECK ("issues"."merged_head" IS NULL OR ("issues"."merged_commit_sha" IS NOT NULL AND jsonb_typeof("issues"."merged_head") = 'object'));--> statement-breakpoint
WITH stamped AS (
  SELECT i.id, i.merged_at
    FROM issues i
   WHERE i.merged_commit_sha IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM repo_pull_request_issues l
         JOIN repo_pull_requests p ON p.id = l.pull_request_id
        WHERE l.issue_id = i.id AND p.state = 'merged'
          AND lower(p.merge_commit_sha) = lower(i.merged_commit_sha))
), latest AS (
  SELECT DISTINCT ON (s.id) s.id, p.merge_commit_sha AS sha, p.merged_at AS at
    FROM stamped s
    JOIN repo_pull_request_issues l ON l.issue_id = s.id
    JOIN repo_pull_requests p ON p.id = l.pull_request_id
   WHERE p.state = 'merged' AND p.merge_commit_sha IS NOT NULL AND p.merged_at IS NOT NULL
   ORDER BY s.id, p.merged_at DESC
)
UPDATE issues i
   SET merged_at = latest.at, merged_commit_sha = latest.sha, merged_head = NULL,
       updated_at = now()
  FROM latest
 WHERE i.id = latest.id
   AND latest.at > i.merged_at
   AND lower(latest.sha) <> lower(i.merged_commit_sha);--> statement-breakpoint
UPDATE issues i
   SET merged_target = p.base_ref, updated_at = now()
  FROM repo_pull_request_issues l
  JOIN repo_pull_requests p ON p.id = l.pull_request_id
 WHERE l.issue_id = i.id
   AND p.state = 'merged'
   AND i.merged_commit_sha IS NOT NULL
   AND lower(p.merge_commit_sha) = lower(i.merged_commit_sha)
   AND i.merged_target IS DISTINCT FROM p.base_ref;
