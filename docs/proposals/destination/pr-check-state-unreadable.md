# A run cannot read whether its own pull request went green

## What was met

ISS-1145 shipped through PR #553 with one criterion that could not be judged from the box that
wrote it: whether the `docs` job — the required check the whole issue exists to unblock — actually
went green on the pull request.

Nothing sanctioned reads a pull request's check runs:

- `forge` has no `github` verb at all, so no check state is reachable from a terminal.
- `forge_source` (named `forge_github` until ISS-50)
  serves `list | diff | check-log | comment | open-change-request | request-review | review`.
  `check-log` needs a `checkRunId`, and **no action returns one**.
- `readPullRequestsForIssues` in `integrations/source-host/repo-projection.ts` does compute a `checks` rollup
  off `repo_pull_requests.checks`, and it reaches exactly one caller: `devices/admissible.ts`,
  behind a device token, listing issues no run has opened yet. An issue being worked is by
  construction not in that list.
- Shelling out to `gh` is refused by `forge_source`'s own contract: it runs under whoever
  configured the box, which is unattributable and unrevocable.

The data is there. The binding reports 402 inbound deliveries with the last one landing a minute
after the pull request opened, so the projection is receiving `check_run` events for it. There is
simply no way to ask.

ISS-1123 met the same gap and wrote it into its own **Out of scope** as *"`forge_github
check-log`, which needs a `checkRunId` no action returns. Same projection, separate deliverable;
reported on ISS-1114."* ISS-1114 is about a master pane's MCP reachability and carries no such
deliverable, so the residual was routed to an issue that does not hold it and has been unowned
since. It is written here rather than filed, because filing it is not one of the three routes a
residual takes.

## What it costs to leave

A run that cannot read its own checks either stops and hands a person a read it could have taken
itself, or asserts a green it inferred from a local command. ISS-1145 took the second with the
inference stated — the `docs` job runs `gaurav-nelson/github-action-markdown-link-check@v1` over
every `.md`, which was run locally with the same config over the same tree for exit 0 — and that
is an inference, not the check.

## The answers, in the order they cost

1. **Return the ids that already exist.** `open-change-request` and any pull-request read hand back
   the projected check runs, so `check-log` has an id to be given. Smallest.
2. **A `checks` action on `forge_source`**, answering the rollup `rollupOf` already computes for a
   pull request by number: name, status, conclusion, and the head sha each was published against.
3. **A `forge github` verb**, so the terminal reaches the same face the MCP client does. This is
   the one ISS-1114 gestured at and is the largest; it is a surface, not a fix.

## A red whole-suite run reaches no issue either

ISS-471 (REQ-36 BC-11) names the merge a red whole-suite run bisects to, in the `suite-bisect` job's
summary on GitHub (`scripts/whole-suite.mjs`). Issue to release r20 `rule-suite` then sends that
merge's issue back to reopen with the failing jobs as its reason, and nothing does. Core does not
even hold the record: the projection folds a `check_run` delivery onto a pull request only
(`packages/core/src/integrations/source-host/projection.ts:rowsForCheckRun` matches its pull
request numbers or a pull request's head sha), and a whole-suite run is on a branch head or a
dispatch commit that no pull request names, so its check run is dropped. Answer 2 above, keyed by a
commit instead of a pull request and fed by a projection that keeps check runs per commit, is the
read that move would stand on; `packages/core/src/integrations/github/merge-read.ts:readHeadChecks`
already reads one commit's check runs live, for the merge door alone. The other route, a Forge
credential in CI, puts a token where every step of every job can read it. Until the bisect read a
skipped `whole-suite` check as no record (ISS-471 round 2) it named the wrong merge on `main`, so a
reopen built before then would have reopened the wrong issue; it stays unbuilt here until it has
this read to stand on.

## Honest costs

| What adopting it takes | From whom |
|---|---|
| A read surface fed by webhooks answers what Forge was last told, not what GitHub holds now, so a run can call a pull request green on a check run that has since been re-run | every caller of the new read |
| Answer 1 alone hands out an id with no rollup beside it, which invites a caller to fetch one log and conclude from one check what the whole set says | the run that reads it |
| Answer 3 costs a verb, its help text, and a second place the GitHub contract has to stay true as it changes | whoever changes that contract next |
| Every answer widens the GitHub face, which is the surface this repo has already had to rebuild twice | the reviewer of the next change to it |
