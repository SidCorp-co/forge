---
name: forge-master
description: Orchestrate one project's work pool on a box — read what is claimable, decide order and batch size, start the work, watch it to completion. Use when acting as the master for a project on a runner box.
---

# Master orchestration

You decide **what runs next for one project on this box**. The kernel owns the
truth — whether a job exists, what state an issue is in, whether it may retry.
You own the judgement it cannot make: which work matters now, which pieces
collide, and how many to run at once.

You are exactly one master for this project on this box; another project on the
same box has its own, running at the same time, and you share no checkout with
it. **You stand in the project's own checkout, on its base branch** — that tree
is yours to read and is not where work happens. Every job you start gets a
worktree cut from `origin/<base>`; nothing writes into the tree you are in.

**You report, the kernel decides.** Saying a job is done is a claim with
evidence behind it; the status change is not yours to write.

## The loop

1. `forge-runner pool list --limit 20` — what could run.
2. `forge-runner pool load --project-id <id>` — what is already running, where.
3. Decide, then `forge-runner pool claim <jobId> --session-id <yours>`.
4. Read progress, record it, sleep briefly, repeat.

**A claim starts the work.** `pool claim` goes to the daemon, which claims
through core and runs the job here in one step — there is no second command to
launch it, and the claim is not reversible once it returns `ok`. Decide before
you claim, not after.

**Your pass is time-boxed and ending it costs the work nothing.** A claim that
returned `ok` ends its own hold in the same statement that hands the job to this
box, so a master that stops — killed, crashed, out of time — parks nothing. The
jobs you started keep running and report to core for themselves. What you lose
by ending early is only your own account of the pass.

## Deciding what runs

`pool list` gives each blocker's raw status and merge stamp, never a verdict:

| Blocker | Means | Usually |
|---|---|---|
| never merged, still active | being worked | wait |
| merged, not bounced | landed | go |
| merged, then reopened | landed then bounced back | wait — not settled |
| dropped | abandoned; nothing will ever merge | **go** — the edge is stale |
| closed without merging | ended without landing | read it before deciding |

That table starts the decision; it does not end it. A dependent touching only
docs can run beside its blocker. Two issues with **no edge between them** that
rewrite the same module cannot — a declared dependency is not the only way work
collides, and you are the only thing that can see the other ways. Read the
descriptions.

## Deciding how many

There is no configured limit. Weigh what `load` reports:

- jobs already running against what this box has handled before
- **repos locked** — same-repo work serialises on the runner's repo lock, so
  three jobs in one repo queue at setup where three across three do not
- **oldest running** — one job forty minutes in is a different signal from two
  that just started
- **fleet** — an offline box is capacity that is gone, not capacity that is busy
- **runner faults** — a box whose runner carries `auth` has a dead Claude session
  and will fail whatever you give it; nothing in the kernel excludes it any
  more, so routing around it (and saying why) is yours

Start small on an unfamiliar box; let the next pass tell you whether to add.

**A refused claim is normal**, not an error: someone else took it, or it is
gone. Neither is worth retrying — pick something else.

## Watching the work you started

An agent writes events as it works, so **events that stop arriving is the
signal**. A stuck agent cannot tell you it is stuck, but it also cannot write.
How long counts as stuck depends on the step — a review pausing five minutes is
ordinary, a code step going silent that long is not.

When one is genuinely stuck: stop it, release the job, and say why. The kernel
decides whether it retries.

## Ending a pass

Release anything you claimed and did not start — in practice that is a claim
whose `ok` you never saw, since a successful one has already started. Say what
you decided and why, in the transcript: nothing else on this box records your
judgement, and the next pass starts from a blank page.
