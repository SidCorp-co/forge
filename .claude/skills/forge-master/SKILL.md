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
3. Decide, then `forge-runner pool claim <jobId> --session-id <yours> --agent <name>`.
4. Read progress, record it, sleep briefly, repeat.

**`--session-id` must be a UUID**, and it is yours for the whole pass, not per
claim: it is the handle core releases your holds by if you die. Generate one at
the start (`uuidgen`) and reuse it. A free-form string is rejected, which reads
as a broken claim rather than a malformed argument.

**A claim starts the work.** `pool claim` goes to the daemon, which claims
through core and runs the job here in one step — there is no second command to
launch it, and the claim is not reversible once it returns `ok`. Decide before
you claim, not after.

## Naming the agents

**You name every agent, and the name is where its work lives.** `--agent <name>`
becomes that agent's git branch and its worktree under `.worktrees/`. Nothing
else names it: a claim without `--agent` is refused (`agent_required`), and a
name that cannot be a branch is refused too (`agent_unusable`) — ASCII letters,
digits, `-`, `_`, `.`, no leading `-` or `.`, 60 characters.

The name is a decision, not a label:

- **One issue, one agent** — name it for the issue (`ISS-175`).
- **Several issues you judge to be one piece of work** — one name for all of
  them (`catalog-eav`), claimed once per job with that same name. They land in
  one checkout, on one branch, and the agents can see each other's work.
- **Issues that must not see each other** — different names. Two names are two
  trees, and neither can read the other.

**Grouping is yours and nothing checks it, so price it before you do it.** Two
issues under one name land on ONE branch and ship as ONE diff — the review for
either sees both, and neither can be merged without the other. That is a real
decision about how the work ships, not a convenience. Group only when you would
be willing to defend "these land together"; when in doubt, two names, because
splitting later means redoing work and merging later costs nothing.

**Reuse the name an issue's work already has.** Nothing carries your last pass's
choice forward, and naming the same issue differently this pass cuts a SECOND
tree from the base branch — the first one's commits then sit on a branch no
review looks at. Before you name anything, look at what already exists:

```
git worktree list          # every checkout on this box, and its branch
git branch --list          # branches that outlived their worktree
```

An issue whose work is already on `catalog-eav` keeps `catalog-eav`, whatever
you would have called it starting fresh. Only work with no tree yet gets a new
name.

**Ending a pass costs the work nothing.** A claim that
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

**A refused claim is normal**, not an error, and the `reason` tells you which
kind:

| reason | what it means | what to do |
|---|---|---|
| `already_held` | another master won the race | pick something else |
| `issue_busy` | another step of that issue is in flight | come back next pass |
| `agent_required` · `agent_unusable` | you sent no name, or an unusable one | fix the name and claim again |
| `runner_too_old` | **this box's runner cannot name a worktree** and would run the agent in the repo root | claim NOTHING here and say so — only updating the runner clears it |
| `budget_exhausted` | the project's monthly budget is spent | nothing on this box helps |

None of them is worth retrying in a loop: no reason above clears by asking
again. `runner_too_old` is the one to report loudly — every claim on this box
will refuse until an operator updates it, so name the box in your transcript
rather than working through the pool getting the same answer.

## Watching the work you started

An agent writes events as it works, so **events that stop arriving is the
signal**. A stuck agent cannot tell you it is stuck, but it also cannot write.
How long counts as stuck depends on the step — a review pausing five minutes is
ordinary, a code step going silent that long is not.

When one is genuinely stuck: stop it, release the job, and say why. The kernel
decides whether it retries.

**Stopping one is yours to do by hand.** Nothing on this box holds a handle to
an agent's process — the daemon spawns it and lets go — so there is no command
that kills it for you. You are a terminal on the same box, so you are the only
thing that can: find the process by the worktree it is sitting in, and stop it.

```
pgrep -af claude | while read -r pid _; do
  printf '%s %s\n' "$pid" "$(readlink /proc/"$pid"/cwd)"
done
```

The one whose cwd is `.worktrees/<name>` is that agent. Kill it, then release
the job. Two rules: never kill a process you cannot place in a worktree you
named, and never kill your own session — check the pid you found is not yours.
A wrong kill takes an agent that was working.

## Ending a pass

Release anything you claimed and did not start — in practice that is a claim
whose `ok` you never saw, since a successful one has already started. Say what
you decided and why, in the transcript: nothing else on this box records your
judgement, and the next pass starts from a blank page.
