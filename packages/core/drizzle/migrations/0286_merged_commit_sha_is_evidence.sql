-- ISS-1073 — `issues.merged_commit_sha` becomes evidence, so what is in it that is not evidence goes.
--
-- Until this change the column held whatever a caller passed to `forge record merged --at <sha>`:
-- a claim, made by whoever typed it, about a merge nothing verified. From this change it holds only
-- a commit Forge watched land — its own `PUT .../merge`, or GitHub's `pull_request` event carrying
-- `merged` — and `issues/merge-record.ts` writes evidence under `merged_commit_sha IS NULL`, so a
-- merge Forge later observes replaces a stamp somebody asserted.
--
-- That predicate is what makes this migration necessary rather than tidy. A row whose column
-- already holds a caller's claim looks, to the new writer, exactly like a row that already holds
-- evidence — so the real merge would be refused forever, the wrong timestamp with it, and the
-- distinction the whole change rests on would be false for every row that predates it.
--
-- WHAT IS KEPT, AND WHERE IT WENT
--
-- `merged_at` is not touched on any row. It answers a second question this change does not move —
-- whether the issue is settled enough to release its `blocks` dependents — and clearing it would
-- re-block every dependent of every marked issue in the fleet
-- (docs/proposals/merged-at-is-two-truths.md).
--
-- The claim itself is not lost. `issues/merge-marker.ts` has written `commit=<sha>` into the mark's
-- own audit comment since ISS-959, so every sha cleared here is still readable on the issue it was
-- claimed for, labelled as what it was. This is a column changing meaning, not a record being
-- cleaned away to make a statement succeed.
--
-- WHAT SURVIVES IN THE COLUMN
--
-- A claim the projection agrees with. Where `repo_pull_requests` holds a merged pull request for the
-- issue whose own `merge_commit_sha` starts with the claimed value, the claim was right and Forge
-- can see that it was: it is left as the evidence it turned out to be. The prefix comparison is
-- there because a caller could name a short sha and GitHub reports the full one, and the column is
-- schema-constrained to hex (`mergedCommitShaSchema`), so no value in it carries a LIKE
-- metacharacter.
UPDATE issues i
SET merged_commit_sha = NULL
WHERE i.merged_commit_sha IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM repo_pull_requests p
    WHERE p.issue_id = i.id
      AND p.state = 'merged'
      AND p.merge_commit_sha IS NOT NULL
      AND lower(p.merge_commit_sha) LIKE lower(i.merged_commit_sha) || '%'
  );
