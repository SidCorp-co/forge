# An agent on an outside-git lane has no work-evidence route of its own

Found while repairing ISS-1318's refusal wording (round r2). Written down rather than worked around,
because closing it changes what the work-evidence gate accepts, and that is more than a wording repair
can carry.

## What stands

`collectWorkEvidence` (`packages/core/src/pipeline/work-evidence.ts`) counts a branch that is neither
the base nor the live branch, an implementation handoff, and `merged_commit_sha`. On a project whose
work lands outside git (kind `website`), an agent's work often leaves none of those:

- the repository is optional there, so there may be no branch to record;
- `applyMergeMarker` (`packages/core/src/issues/merge-marker.ts`) refuses an agent's mark with
  `NO_WORK_EVIDENCE` before it reads `data.landing`. The commit route ISS-1318 added is read on `git`
  alone;
- a `landed` mark writes `merged_landing`, not `merged_commit_sha`, so even a person's mark leaves
  `hasCodeEvidence` false, and the agent's move to `developed` or `testing` is still refused.

Since r2, the refusal says exactly that. It names the branch and handoff routes and a person's mark and
move. But an owner-lane agent on such a project with no branch has no route of its own.

## The shapes a fix could take

1. **Count a landing as evidence on `outside_git`.** `collectWorkEvidence` reads `merged_landing` where
   `merged_at` is set and the lane is `outside_git`, the way it reads `merged_commit_sha`. An agent's
   mark carrying `data.landing` is then let through the gate on that lane. The landing is free text, so
   this accepts a claim nothing checks.
2. **Check the landing first.** The same, but only after the landing is read back from the live
   resource it names (the storefront binding, the URL). This is the analogue of `readCommitLanding`,
   and it needs one reader per kind of landing.
3. **Leave it to a person.** Keep today's gate and document the person's mark and move as the route on
   this lane, as the refusal now does.

## Honest costs

Option 1 lets an agent satisfy a kernel gate (`VISION: kernel-hard-policy-soft`) with an unchecked
string, which is the shape ISS-1318 refused for commits. Option 2 costs a reader per landing kind and
a binding to read through. Option 3 costs a person's act on every agent-driven website issue. The
residual ends when the owner picks one, and an issue is cut for it.
