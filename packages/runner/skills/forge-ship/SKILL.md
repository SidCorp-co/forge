---
name: forge-ship
description: "Phases 6-7 of the autonomous pipeline: merge into the base branch, pass the deploy gate, write the changelog line and the close comment. Triggers on: /forge-ship, merge and close this issue, ship this issue."
survives_kill_switch: false
user_invocable: false
arguments: "issueId"
---

# forge-ship

The review approved. Two things left: land it, and account for it.

## Merge

Into the base branch you checked out from. That is yours and needs no permission.

Resolve the target from the project's own configuration, not from the plan text and not from
habit — a project whose base branch changed will have stale branch names written into older issue
descriptions, and following them merges into the wrong place silently.

Merging anywhere else needs a human. Ask, do not assume.

If the merge conflicts, that is phase 3 again, not a failure: re-declare `code`, resolve, and come
back through review if the resolution changed behaviour.

## Deploy gate

`projectFacts.deploy-policy` says whether a deploy happens on this project and what gates it. You
request it; the cloud allows it or does not. A refusal is not an error to work around — if deploy
is gated, the gate is the answer.

If a deploy runs and does not come up, do not close the issue. Comment with what you saw and set
`needs_info`. A green merge with a dead deploy is the exact state that looks finished and is not.

## Account for it

One comment. It is the only record a human will read, so it carries everything that is not in the
diff:

| Section | Content |
|---|---|
| What changed | one paragraph, in terms of the reported problem, not the files |
| Extra fixes | defects you fixed that were not in the acceptance criteria |
| Left unresolved | anything you found and did not fix, and why |
| Verification | what you ran, and what it said |

`Left unresolved` is not optional and it is not a confession. Something out of reach leaves as one
of: a `blocks` edge onto the issue that would ship without it, a line in `docs/proposals/`, or this
comment saying plainly that a human must decide. It does not leave as a new issue.

## Changelog

One line under `## [Unreleased]`, written for someone who does not know this issue exists. If the
change is invisible to users, say so and write nothing — an entry that says "refactored internals"
is noise in a file people read to find out what changed for them.

## Close

`closed` when your work is on the base branch. It stamps `merged_at`, which unblocks every issue that
declared a `blocks` edge on this one — so closing something that did not actually land releases work
that is not ready.

On a project with a release gate the cloud does not take your `closed` at face value: it stamps the
merge, closes your session, and parks the issue at the gate. It is `awaiting release`, not done, and
a release closes it later. You cannot write past that, so do not try, and do not describe the issue
as shipped, deployed or live in your comment — say what you merged. You do not know whether anything
was released, and the comment is the record a human reads.

`dropped` when it turned out not to be work. It closes without stamping and is never held.

Never leave it `in_progress` because you are unsure which. Say which in a comment and pick.
