# A GitHub compare past 300 files reads as unreadable

Found by ISS-1398's judge j4 on beta at `b2dae5a`. On a project read through its GitHub binding, a
release weighing whose two commits differ in 300 or more files is held "could not be read", even when
production descends from the judged commit. `packages/core/src/integrations/github/repository-reader.ts:filesOf`
refuses any compare whose file list reaches `COMPARE_FILE_CEILING` (300), the most GitHub's compare
names in one answer. The judge saw it live: `0b67761`, an ancestor of `b2dae5a` 4592 files behind,
was held unread through forge-dev's binding. The deploy-key route, which reads with git, earned a
2461-file gap on the same check.

So on a GitHub-bound project with automatic release, forge-dev among them, a verdict judged far
behind what production serves is never counted until someone judges it again at a nearer commit.
ISS-1398 left the GitHub route's answers as they were (its criterion 17), so this predates it.

The choice nobody has made: read the whole file list some other way where the compare is cut, or keep
the refusal and say what clears it.

## Honest costs

| Choice | Cost |
|---|---|
| read past the first 300 files | first check whether the compare's own paging lifts the ceiling for files as it does for commits; if not, per-commit reads or the tree API, one request per commit or per tree, against the binding's rate limit |
| read the range with git through the binding's token | a second read path beside the API for the same project, which ISS-1398 avoided on purpose |
| keep the refusal, and have the hold say to judge again at a commit nearer production | no new reads; every long-lived verdict on a busy project costs another judge |
