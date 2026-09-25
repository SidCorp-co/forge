# What a live-branch reading cannot see

ISS-1217 places a merged issue on a `promote` project as not on the live branch when one of its
commits is on the base branch and not an ancestor of the live branch
(`packages/core/src/projects/live-reach.ts:liveReachOf`). Ancestry is the whole premise. One way
of releasing that the tree does not model breaks that premise, and it is recorded here rather than
filed as an issue, as the rules require for a residual.

## A hand cherry-pick onto the live branch reads as not on live

On a project whose `releaseStrategy` is `merge-branch`, a person sometimes copies an issue's
change onto the live branch by hand instead of promoting the base branch. The live branch then
carries the change under a different sha. The base branch's commit stays out of the live branch's
ancestry, so the reading lists it as waiting, and an issue that commit is attributed to reads "Not
on production" while its change is in fact live.

Measured on portal-lighthuman on 2026-09-25, with `stg` at `bb4fb368` and `master` at `1ab11b76`:

- **ISS-55** reads `not_on_live` on `0cc3102` and `6d278297`. `master`'s `954e8340` is those two
  commits squashed into one: its diff of `react-app/nixpacks.toml` is byte-identical to
  `6d278297`'s, and the rest of the diff is `0cc3102`'s. `git cherry` cannot match a squash of two
  commits to either one.
- **ISS-59**'s `07002be8` is on `master` as `62d59254`, and `git cherry origin/master origin/stg`
  marks it `-`, meaning patch-equal. ISS-59 reads `none_waiting` only because no rule gives
  `07002be8` to any issue. It is listed among the waiting commits that belong to no issue.

The two cases need different remedies. A patch-equal cherry-pick is visible to
`git log --cherry-pick --right-only live...base`. The deploy-key source
(`packages/core/src/git/remote-divergence.ts`) could exclude those commits. The GitHub compare
cannot, because it returns no patch ids. A squash made by hand has no mechanical match in either
source. Its change reaches the live branch only through the release record for the issue: a
verification naming the live deployment that serves it.

What is open is which of these a `promote` project should rely on. One option is to treat a hand
cherry-pick as a release the issue records and the reading defers to. The other is to hold
`merge-branch` projects to promotion and let "Not on production" stand until the base branch is
promoted. That is a decision about the release model. It belongs to a person, not to a diff.

## Honest costs

| Choice | What it costs, and who pays |
|---|---|
| Leaving ancestry as the whole premise | An owner on a project that cherry-picks by hand sees "Not on production" on a row whose change is live, for example portal ISS-55 today. They lose trust in the one reading built so they would not have to compare branches themselves. |
| Excluding patch-equal commits on the deploy-key source only | The same repository reads differently depending on whether a GitHub binding or a deploy key reaches it. A squash made by hand still reads as waiting, so the fix answers ISS-59's shape and not ISS-55's. |
| Deferring to a recorded live verification | A row is placed off live only until someone records where its change runs. That hands the reading back to the release record, which is the promise ISS-1217 was filed because nobody checks. |
