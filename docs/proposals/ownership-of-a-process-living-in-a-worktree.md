# Ownership of a process living in a worktree

**Removed when:** every `logged_while` copy in forge-runner-core is folded into `crate::log_capture`
and the three field-triggered amnesties are recorded in the doc comments that enforce them, which
dev ISS-123 carries. The change that lands it deletes this file.

ISS-1271 made a worktree's removal end the processes living in the checkout, attributing them by
residence: a process belongs to a checkout when `/proc/<pid>/cwd` resolves to it or beneath it, and
by nothing else. Two residuals were priced rather than closed, and this is where they are written
down so whoever picks either up finds the mechanism rather than the symptom.

## Residence proves where a process is, not whose it is

A process the operator started by hand inside a checkout that no run holds, that is fourteen days
old and that is being given back, is ended with the checkout. Four things bound that today: the
ledger says no run holds the tree before either removal route is reached; this process and its own
ancestors are never signalled; a pid handed to another process between the reading and the signal is
never signalled; and a process of another user is refused by the kernel with `EPERM`, which stands
and refuses the removal rather than dying quietly. Every pid that is ended is named in the journal
by pid, command line and working directory.

What would close it is a marker the run's processes inherit and a stranger does not. The only shape
that reaches `next-server`, headless Chrome and a test harness — none of which cooperate — is an
environment variable written where the agent is spawned, `runner::claude_code` and
`daemon::terminal`, read back from `/proc/<pid>/environ` the way `daemon::serving::serves` already
reads one. The wrinkle to settle first is the pane route: a process started in a tmux pane inherits
the tmux *server's* environment, not the client's, so the variable has to reach the pane's own
command rather than the client that opened it.

The condition that ends the amnesty is the first report of a process this attribution ended that
should not have been.

## A platform with no process table is not covered at all

`residents_of` answers three ways. A root that is not there is `NoTable`: the removal proceeds as it
did before ISS-1271, saying at `warn` on every such removal that it could not look. A root that is
there and will not open is `Unreadable`, and the removal refuses. So on macOS and Windows the
issue's outcome is not enforced, and a leak there would be as silent as it was everywhere before
this change. Refusing instead would stop worktree reclaim outright on those platforms over a leak
measured only on Linux, and no portable reading replaces `/proc`: another process's working
directory on macOS is `proc_pidinfo` with `PROC_PIDVNODEPATHINFO` behind `libproc`, which this
repository has no way to exercise in its own CI.

The condition that ends this one is the first orphaned listener observed on a non-Linux box.

## The window between the last reading and the removal

`Clearing::clear` ends the residents and then takes a FRESH reading, so a resident that forks a
replacement while it is being asked to go is caught. What that cannot establish is ownership of the
path *through* the removal: a process can change its working directory into the checkout after the
second reading returns and before `git worktree remove` takes the directory, and the removal then
succeeds over a live process whose working directory is gone. The window went from unbounded to the
milliseconds between two calls; it did not close.

Closing it needs an admission barrier rather than a third scan — quarantine the tree, scan the
quarantined path, then remove it. The only rename that keeps git's registry honest is
`git worktree move`, and taking it here is a change of its own shape: it refuses a worktree holding
submodules, it changes the path in every line an operator greps the journal for, it gives the reap
sweep's `remove_dir_all` fallback a different path to fall back to, and ISS-1193 on this box is the
record of what worktree paths moving out from under the registry costs.

There is a backstop in the meantime, added by the same change: the sweep names every process whose
`cwd` is a `(deleted)` path under a worktree root, so a process that arrives inside the window is
reported at the next sweep rather than living unnamed for three days, which is what the two orphans
in ISS-1271 did.

The condition that ends this one is a process observed arriving inside that window in the field, or
a second issue asking for the quarantine on its own terms.

## Nine copies of the log-capture helper

`forge-runner-core` held nine copies of the same `logged_while` test helper — in
`workspace::worktree`, `runner::close_loop`, `daemon::headroom`, `daemon::pool_jobs`,
`daemon::session_tokens`, `daemon::recovery`, `daemon::mod` and twice in `daemon::master` — several
of them noting in a comment that the shared one was out of reach from where it was needed.

ISS-1271 put one where every unit test in the crate can reach it, `crate::log_capture`, and folded
`workspace::worktree`'s copy into it. The rest were not folded: `daemon::master` was held by another
change's branch at the time, and none of the other files was in the declared file scope of a batched
change, where an undeclared file makes a red gate unattributable. A later change added one more, in
`transport::provision`, so nine private copies stand today across eight files: `runner::close_loop`,
`transport::provision`, `daemon::headroom`, `daemon::pool_jobs`, `daemon::session_tokens`,
`daemon::recovery`, `daemon::mod` and two in `daemon::master`. Each is a `use
crate::log_capture::logged_while;` and a deletion, and `crate::log_capture` also carries a guard
form, `capturing()`, that an `async` test needs and that none of the copies has.

## Honest costs

| Choosing this | What it costs |
|---|---|
| Residence as the whole predicate | A process the operator started by hand inside a checkout that no run holds and that is being given back is ended with it. The journal names every pid ended, so the cost is a surprise an operator can trace, not a silent one. |
| Refusing a removal over a resident that will not die | A release refused this way holds the run's leases until `RELEASE_GRACE_SECS` or `RELEASE_ATTEMPT_BOUND` decides it, and the sweep leaves that checkout's disk unreclaimed for a full six-hour period each time it meets it. |
| Proceeding where there is no process table | On macOS and Windows the guarantee is not enforced at all, so a leaked listener there stays exactly as invisible as it was before ISS-1271, and every removal on those platforms carries a `warn` line that reads as noise until the day it does not. |
| Closing the residence residual with an inherited marker | Two spawn paths change, `runner::claude_code` and `daemon::terminal`; the tmux pane route needs the variable put on the pane's own command rather than the client's; and every process started before the change carries no marker, so the reading needs a fallback for as long as any of them lives. |
| Leaving the window between the last reading and the removal open | A removal can still succeed over a process that entered the checkout in the milliseconds after the final scan, and the only thing that reports one is the next sweep, up to six hours later. |
| Closing that window with a quarantine | `git worktree move` per removal: a second git call on every reap, a refusal on any worktree holding submodules, a path in the journal that is no longer the path an operator knows, and a fallback route that has to follow the move. |
| Counting rather than refusing a working directory the kernel will not show | A process of another user living in the checkout is neither ended nor refused over; the removal proceeds and the line says how many pids it was not allowed to ask about, which on this box is most of them — 804 of 1074. |
| Folding the remaining nine log-capture copies | Eight files are touched for no behaviour change, each one a file some other change may hold, so the fold has to be taken when no branch is open across them or it buys a merge conflict per file. |
