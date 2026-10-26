# A red whole-suite run reaches no issue

## Where it stands

A run can read its own checks now: `GET /api/projects/:id/integrations/source/commits/:sha/checks`
and `…/branches/:ref/checks` answer, live from the host, every check on a commit or a branch head
and the rollup of the latest run per name
(`packages/core/src/integration-door/source-projection-routes.ts`). Each check carries its id, so
`…/checks/:checkRunId/log` has an id to be given. On GitHub that is the commit's check runs and the
commit statuses an outside CI posts; on GitLab, the commit's pipelines.

## What is still unbuilt

ISS-471 (REQ-36 BC-11) names the merge a red whole-suite run bisects to, in the `suite-bisect` job's
summary on GitHub (`scripts/whole-suite.mjs`). Issue to release r20 `rule-suite` then sends that
merge's issue back to reopen with the failing jobs as its reason, and nothing does. Core does not
hold the record: the projection folds a check onto a change request's row only
(`packages/core/src/integrations/source-host/projection.ts:rowsForCheckRun` matches its request
numbers or a request's head sha), and a whole-suite run is on a branch head or a dispatch commit no
request names, so its check run is dropped. The live commit read above is the read that move would
stand on; a reopen keyed by commit would ask it rather than a projection. The other route, a Forge
credential in CI, puts a token where every step of every job can read it. Until the bisect read a
skipped `whole-suite` check as no record (ISS-471 round 2) it named the wrong merge on `main`, so a
reopen built before then would have reopened the wrong issue; it stays unbuilt here.

## Honest costs

| What adopting it takes | From whom |
|---|---|
| A reopen driven by a live read answers what the host holds at the moment it asks; a re-run that goes green after the reopen does not undo it | whoever reads the reopened issue |
| A projection keeping check runs per commit grows with every push, where the per-request row is pruned to its head and fifty others (`projection-shape.ts:FOREIGN_CHECK_RETENTION`) | the database, and whoever prunes it |
