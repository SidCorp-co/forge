# 0009 — The runner is a thin box agent

**Status:** accepted · **Date:** 2026-10-05 · **Supersedes:** none; applies `VISION: kernel-hard-policy-soft` to `packages/runner`

## Context

The owner said on 2026-10-05 that the codebase was far larger than the value it delivered, and
asked for it to be cleaned of legacy and unused code and then simplified. The Rust runner was
the second-largest package: 85,445 real lines (non-blank, non-comment) in two crates,
`forge-runner-core` and the `forge-runner` binary, read at `3e863ad68` on `dev`. 53,827 of those
lines were tests, which dev no longer carries (ISS-172 removed the TS ones on 2026-10-04).

Two readings of the remaining production code disagreed about what it was:

- **A first reading** took the runner for a second brain: it held a run ledger, reapers,
  a master protocol and its own verdicts, so it seemed to duplicate core across the board.
- **The value census** (2026-10-05, `~/forge-local-docs/value-census.html`) corrected that. Most of
  what looked duplicated is split on purpose:
  - **The box ledger is the authority by design** (`packages/runner/crates/runner-core/src/ledger/`, ISS-933), and core keeps
    a mirror of it (ISS-934). Only the box can say which processes and checkouts it holds.
  - **The reapers are split on purpose.** Core reaps leases and state; the runner reaps processes
    and worktrees, which only the machine can see.
  - **Core's `devices` `master-*` code** (about 1k lines) is the core half of the master
    protocol, not a copy of the runner's.
  - **`forge-runner top`** (4.6k lines) *was* a duplicate: a second run-standing read model,
    against REQ-15. ISS-220 deleted it.

What the census did not settle was where the line runs between a fact the box reports and a
decision it takes. Some runner code decides things core already decides, or should: whether a
job turn ended the job, whether a run is over, whether a master should be placed.

## Decision

**The runner is a CI-style box agent, in the mould of GitLab Runner or Buildkite Agent, not a
second brain.** It does only what the local machine alone can do:

- pair the device and hold its credential;
- receive a job and run the agent (Claude Code today, codex later);
- own worktrees and panes;
- stream events to core;
- reap processes;
- update itself.

**Every decision belongs to core**: dispatch admission, leases, retry, master limits and
headroom, recovery verdicts and turn-evidence judgement. The runner asks and obeys. Where it reads
a fact only the machine has, such as a transcript, a pid, or a disk's free space, it reports the fact,
and core takes the verdict.

The exceptions above keep their place: the box ledger stays authoritative, and the process and
worktree reapers stay on the box.

### The shape it is rebuilt into

A Cargo workspace whose crate boundaries are the dependency rule, enforced by the compiler:

| Crate | Holds |
|---|---|
| `forge-runner` (bin) | the `clap` CLI; `start` hands config to the daemon |
| `runner-platform` | Linux, macOS and Windows differences: config dir, credential store, processes, git |
| `runner-proto` | the frames core sends and the heartbeat conditions the box reports |
| `runner-update` | self-update |
| `runner-transport` | the core connection: `CoreClient` (HTTP) and the WebSocket |
| `runner-core` | the box ledger and the run, job and pane verdicts read off it |
| `runner-workspace` | git worktrees, tmux panes, MCP config, process reaping |
| `runner-agent` | `trait Runner`, with the Claude Code implementation |
| `runner-daemon` | the actors, one tokio task per long-lived component, and the master protocol |

As built (ISS-218), three cells differ from the plan, and the code is the record:
`runner-daemon` exists because the actors and the master protocol are a library the CLI's own
commands (`master`, `status`) read, not wiring; `runner-core` holds the SQLite ledger, so it is not
IO-free, because the ledger is the box's authority (ISS-933) and every verdict reads it; and the
wire structs stay beside the transport calls that send them, `runner-proto` holding only what more
than one crate reads.

The choices inside that, and why:

- **Crates, not modules, as the boundary.** One library crate lets any file reach any other, and
  ADR 0008 showed in core what that produces. A crate cannot import upward without the compiler
  refusing it, so the rule needs no checker of its own.
- **Actors for concurrency.** One tokio task per long-lived component and one per job. Each owns
  its state and talks to the others over channels. At `3e863ad68` the runner shared state
  through 40 `Arc<Mutex>` sites, against 8 files using channels; shared state is what makes a pane
  and a job disagree about which of them holds a slot.
- **`thiserror` in the library crates, `anyhow` only in the binary**, so a library error names
  its cause and only the outermost layer flattens it.
- **Size gates.** clippy's `too_many_lines` at a threshold of 100 (`clippy.toml`), and no
  production section of a `.rs` file over 800 lines, held by a small check script. Inline
  `#[cfg(test)]` modules are idiomatic and allowed when tests return.
- **Not adopted: full DDD or hexagonal layering.** The runner has almost no domain; the extra
  layers would only add code.

### How the change is made

- **Cleanup first (ISS-216).** Delete legacy and unused code, the Rust test modules and
  the crates' integration-test directories (the QA phase rewrites them, as ISS-172 plans for TS), and any decision code core already makes.
  Decision code core should own but does not yet is listed, not moved. No crate split.
- **Simplify second (ISS-218).** Split into the crates above and turn shared state into actors.
- **The wire protocol keeps working** against the core on `dev` through both phases. A change a
  caller can see is named in its change, never made silently.
- **On-disk state an installed older runner may still hold is a promotion carry-over.** A
  config-key rewrite, a ledger column added on open, or an old keychain service name stays until
  every box has run the build that no longer needs it, and its change says so.
- **macOS and Windows** keep compiling. Their `cfg(target_os)` code is checked with
  `cargo check --target` where the box has the target, and by reading where it does not.

### What core takes over

Four decisions the box took were each one too-long function under a `too_many_lines` amnesty.
Each was deleted, not split, once core answered it, and no such amnesty remains:

- **Placement and retirement** of a master: `POST /api/devices/me/master-session/verdict`
  (`packages/core/src/masters/verdict.ts:masterVerdict`).
- **Recovery verdict** on a run the box ledger holds open: `POST /api/devices/me/run-sessions/verdict`
  (`packages/core/src/devices/run-verdict.ts:runVerdict`). The box reports the pid, pane,
  transcript and checkout facts, and beats, ends, closes or releases as told.
- **Idle verdict** on a resident chat session: core's loop monitor sends `agent:close` once its
  residency is over (`packages/core/src/jobs/park-deadline.ts:closeIdleResidents`); the box keeps no
  residency clock.

The facts those verdicts read were then taken out of the box's hands too, so that it reports what it
saw and judges none of it:

- **How a master pass ended**: each tick the box reports what it holds about the open pass (who
  opened it, its session, the hooks' turn counts, the transcript's age, the issues declared, the
  conversation's record) as `{ op: "settle" }` on `POST /api/devices/me/master-session/pass`, and core
  closes it with its reason (`packages/core/src/masters/pass-end.ts:passEnd`).
- **What a master is owed**: core reads the admissible issues, the channel, the issue threads, the
  requirements, the feedback and the returned designs itself, and answers them beside the verdict
  with the nudge line, the first pass's brief and the digest the box echoes as its last nudge
  (`packages/core/src/masters/owed.ts:readMasterWork`).
- **Whether a master sits behind its account limit**, and **whether a run it holds is over**: the box
  reports the newest refusal in the pane's conversation with what its hooks say, and each held run's
  subagent evidence with no bound (`packages/core/src/masters/verdict.ts:limitHeld`,
  `packages/core/src/devices/run-verdict.ts:subagentOver`).

## Consequences

- **What the cleanup took.** 85,445 real lines became 30,391: 53,827 lines of tests and test
  scaffolding, plus 1,227 lines of production code nothing called or that answered a
  shape core no longer sends. That covers the blocked-run park, the setup agent, the ledger's question,
  claim-hold and revival writers, the `runner:register` switch, and the Claude Code runner's
  issue-job arms (its only job spec is chat).
- **Decisions still made on the box.** A pool job pane's idle verdicts (`runner-core`'s `job_exit`,
  `job_unheard` and `turn_evidence`) and the retry of a refused run declaration are made on the
  box today. Until core takes the first, the runner suppresses core's own job timeouts by acking a
  pool job as soon as its pane opens and posting progress every tick. Two more read only what the
  box itself holds: withdrawing a pane stood down while it was being placed obeys the owner's act in
  the box ledger (`packages/runner/crates/runner-daemon/src/master/obey.rs:withdrawn_if_stood_down`), and whether an account record is fresh
  enough to report the account's limit to core is judged against `packages/runner/crates/runner-daemon/src/master_limit.rs:FRESH_WITHIN`,
  which still derives from a hand copy of core's `MASTER_NUDGE_REFRESH_SECONDS` until
  `/api/devices/me/limit` takes the raw record.
- **The ledger keeps columns nothing writes any more** (claims, revivals, questions). Dropping them
  is an on-disk migration on every box, so it waits for the same condition as any other promotion
  carry-over.
- **The cost.** The crate split holds the dependency rule; the 23 `Mutex` sites left after ISS-216
  are per-component memos (a registry, a latch, a sink), kept because an actor per memo would add
  a message type and a handle each, and grow the code the simplify phase exists to shrink.
