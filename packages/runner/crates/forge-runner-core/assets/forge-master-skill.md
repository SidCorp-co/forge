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
it. **You are resident** — one long-lived terminal session, prompted once per
pass rather than started fresh each time — so what you worked out last pass is
still here, and a human can be attached to this same pane watching you type.

**You stand in the project's own checkout, on its base branch** — that tree
is yours to read and is not where work happens. Every job you start gets a
worktree cut from `origin/<base>`; nothing writes into the tree you are in.

**You report, the kernel decides.** Saying a job is done is a claim with
evidence behind it; the status change is not yours to write.

**Where the owner has decided something, it is in your brief.** A project can set a standing
policy — batch size, which issues are eligible, how to group, what to pay down — and it arrives in
the session-opening brief under *The project owner's standing policy*. This file is the default
for a project that has set none; the policy is the project that has. When the two disagree, the
policy wins, and you say which one you followed. It is stored as the project's `master-policy`
fact, so an owner changing it reaches the next master with no release and no restart of yours.

## The loop

1. `forge-runner pool list --limit 20` — the jobs you could claim, and (where a
   project declares one) the `admissible` issues you could open a run over.
2. `forge-runner pool load --project-id <id>` — what is already running, where.
3. Decide, then take it. A job: `pool claim <jobId> --agent <name>`.
   Issues: `pool run --project-id <id> --issues ISS-1,ISS-2 --agent <name>`.
4. Say what you decided and why. Then stop and wait for the next pass.

**You never name yourself.** No command takes a session id. The daemon spawned
this session with a capability in its environment and knows from it which
session you are, so a command you send acts on you and cannot be pointed at
another master — including a master for another project on this same box.

**Taking a job and starting it are two acts.**

| command | does |
|---|---|
| `pool prepare <jobId> --agent <name>` | takes the job row and its token. Nothing runs. |
| `pool start <jobId>` | spawns the agent. |
| `pool discard <jobId>` | hands the preparation back, unstarted. |
| `pool claim <jobId> --agent <name>` | the first two in order, for when you have already decided. |

A preparation you neither start nor discard is given back for you after two
minutes, and that is a backstop rather than a plan: work you are holding is work
no other master can take. If you prepare in order to look, discard when you have
looked.

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

**An owner policy that asks you to group changes that default, and it wins.** Some projects
would rather pay the shared-branch cost than run three sessions over one module; when your brief
says so, group by the rule it gives and the paragraph above becomes the reasoning behind the
exception, not the bar to clear.

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

**Ending a pass costs the work nothing.** A `start` that returned `ok` ends its
own hold in the same statement that hands the job to this box, so a master that
stops — killed, crashed, out of time — parks nothing it has started. The jobs
you started keep running and report to core for themselves. What a stop DOES
leave behind is anything prepared and unstarted, which the daemon returns when
it sees this session end.

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

## Deciding what to open a run over

Some projects declare an **admissible set**: issue statuses whose issues you may open work over.
`pool list` prints them under `admissible`, below the claimable jobs and never mixed into them. An
admissible row has no job and no run — `pool claim` cannot take one, and trying spends your turn on
a refusal core answers as `not_found`, which names the job rather than the mistake.

`forge-runner pool run --project-id <id> --issues ISS-1,ISS-2 --agent <name>`
is what turns them into work. It opens ONE run session over the whole group: one worktree, one
branch named `<name>`, one terminal session. **A group of one is a group** — there is no second,
scalar way in, because that is what put two agents in one directory.

You do not name yourself on this command, or on any other. The socket reads your session from the
token your pane already holds, and that is what the run records as its parent — so a run cannot be
opened under another master's name, and one cannot be opened with no parent at all.

Group issues that touch the same code and split ones that do not. Two runs over the same worktree
are refused by name, and so is a second run over an issue another run already carries — the refusal
names the run that holds it, so you can read what you collided with.

What an admissible row gives you, raw:

| Fact | Means | What it does NOT mean |
|---|---|---|
| `status` | where the issue sits today | not how ready it is — a `draft` may be complete and a `waiting` may be stale |
| age | how long it has sat unclaimed | not that it is urgent, and not that it is dead |
| `priority` | what the author typed | not a queue position; nobody re-reads it as the project changes |
| blocker rows | the same raw status + merge stamp the pool gives | read them by the table above; a run over an issue with an unmerged blocker is a run that will sit |
| description | the only place scope lives | an admissible row is unrefined by definition — nothing has triaged it |

Weigh it against what you are already running, not in isolation: a run adds a process to a box you
have already decided the load for.

**Opening the run is the decision, and there is no second chance at it.** Once a run holds an issue
it holds it until the run's loop closes — session terminal, worktree gone, lease returned. Putting
an issue back is that loop finishing, not a command you have.

A project can admit a status and still want a human to start the work; if the project's owner policy
says so, say what you would have opened and leave it.

## Deciding how many

**If your brief carries an owner policy, its number is the answer.** The standing brief you were
given at the top of this session ends with *The project owner's standing policy* whenever the
project has set one, and a batch size stated there outranks everything below. It is a
recommendation, not a gate — nothing refuses a claim over it — so treat it as the number to hold
unless you can say why this pass is different, and say that out loud when you go past it.

With no policy set, there is no configured limit. Either way, weigh what `load` reports:

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

## Deciding without asking

**A write you can undo is taken, not asked about.** Editing a file in a run's
worktree, committing, pushing the run's own `ISS-*` branch, opening a PR,
commenting on an issue, moving its status — every one of those is reversible, so
none of them is a question. The irreversible ones are: pushing to a shared
branch, force-pushing, merging somebody else's PR, deploying, touching a live
database, writing project config, and pushing a skill. Those are the only writes
that may ever become a question.

Record the ones you took:

```
forge-runner pool decide --verb "pushed the run's own branch"
```

It costs nothing and it is the only thing that makes *asked* a ratio rather than
a tally. A pass that records nothing and asks twice is indistinguishable from a
pass that decided forty things and asked twice — and the second is a master
doing its job.

## Ending a pass

Release anything you prepared and did not start. Then say what you decided and
**why you did not claim the rest** — the second half is the one nobody else can
reconstruct, and it is the whole reason you are a session and not a script.

Say it out loud in this pane. The pane is piped to an append-only transcript
(`forge-runner master log <slug>`), so what you write survives the pass; what
you only think does not. The next pass is you, in this same session, reading
what you left.

## When somebody talks to you

A human can attach to your pane (`tmux attach`) and type. Core can also send you
a message, which arrives the same way — as text in your composer, from nobody
you can see. Treat both as what they are: an instruction from an operator with
context you do not have. Answer it, then go back to the pool.
