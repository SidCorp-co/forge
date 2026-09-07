# A `forge-runner` restart takes down every session on the box, not just the daemon's

- Status: **measured, undecided** — the fix is a one-line unit change with a real trade-off, and the
  trade-off is the owner's, not a diff's.
- Related: `packages/runner/crates/forge-runner/src/cmd/service.rs` (the unit is generated there) ·
  `docs/proposals/agent-driven-pipeline.md` (the session-per-run model this cost is paid against)

## What happens

`systemctl --user restart forge-runner` kills **the tmux server**, so every pane on the box dies —
including master panes and interactive sessions that are not the daemon's children in any meaningful
sense. Measured three times on 2026-09-07 (06:31:13Z, ~11:33Z, 16:47:49Z). The 06:31Z one cost the
uncommitted work of three `drive` sessions: 34 modified files across three worktrees, 0 branches
pushed, and the sweeper marked all three jobs `failed` / `infra` with *"silent runner/agent death"*
five minutes later. The work was recovered by hand afterwards, which is not a plan.

## Why

The generated unit (`service.rs`, the `format!` block) declares `Type=simple`, `Restart=always`,
`RestartSec=5` and **no `KillMode`**. systemd's default is `control-group`: on stop it signals every
process in the unit's cgroup. The daemon starts its agents through tmux, so the tmux server is in
that cgroup, and so is every unrelated pane that server owns.

## The trade-off, which is why this is a proposal and not a commit

`KillMode=process` would leave the tmux server up — and would also leave **orphaned agents running
after a stop**, holding worktrees and writing to the tracker with nobody supervising them. That is
the opposite failure and it is worse in a different direction. The real options:

1. `KillMode=process` plus an explicit reap of *the daemon's own* agents on shutdown, so the
   distinction is drawn by ownership rather than by cgroup membership.
2. Start the tmux server outside the unit's cgroup (`systemd-run --user --scope`, or a separate
   `forge-tmux.service` the runner talks to), leaving the kill semantics alone.
3. Accept it, and make the daemon commit-and-push every agent's worktree before it exits — which
   only helps agents, never a master pane.

Option 1 changes what a stop means. Option 2 adds a second unit to install and version. Option 3 is
the narrowest but does not fix the reported symptom at all. None of the three is a detail a session
can pick on the owner's behalf, and the measurement above is the input that decides it.

## Honest costs

| Choice | What it takes from whoever adopts it |
|---|---|
| Option 1 — `KillMode=process` + explicit reap | A stop stops meaning "everything this unit started is gone". A reap that misses one agent leaves a process writing to the tracker unsupervised — the failure the current default makes impossible — and somebody owns keeping that child list correct forever. |
| Option 2 — tmux outside the cgroup | A second unit to install, enable, version and order on every box. `forge-runner install` grows a second file it can get wrong, and a half-installed pair is a new state to diagnose. |
| Option 3 — commit-and-push before exit | Does not fix the reported symptom: a master pane still dies. The daemon now writes to git on shutdown, so a stop can fail, hang on a credential prompt, or push a broken tree under a subject nobody chose. |
| Doing nothing | Every restart is a small outage of every session on the box, recovered by hand if anyone notices in time. Three restarts on 2026-09-07 cost one salvage pass, 34 files re-committed by hand, and three re-dispatched jobs. |
