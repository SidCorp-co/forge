# A pane's control capability cannot outlive the session row it names

**Status:** decided, unbuilt. The owner chose **shape 1** on 2026-09-20, on ISS-1099. What is built
so far makes the box able to *say* a pane has lost its authority; nothing yet lets a pane keep it.

**Why this page exists twice.** An earlier version of it was an open residual — three shapes, a
table of honest costs, and `No fix proposed here` — and it was deleted on 2026-09-20 in the cull
that left `docs/proposals/destination/` standing. The decision that followed it lives in a comment
on ISS-1099, which is an issue that will close. This page is the decision, so that closing it does
not take the promise with it.

## The mechanism

A master pane carries one capability, `FORGE_CONTROL_TOKEN`, minted into its environment at spawn.
`daemon/session_tokens.rs` maps that token to the core `agent_sessions` id the pane was registered
under, and `run_declare` in `daemon/control.rs` resolves the caller through it. A pane cannot be
handed a new one: its environment is fixed at exec.

Core's side, `devices/master-session.ts:ensureMasterSession`, reuses a master session row only while
it is non-terminal and reaps one whose heartbeat stops. So a pane's capability is valid exactly as
long as its session row lives. When the row goes terminal under a still-running pane, the next
registration creates a second row, the daemon adopts the pane onto it, and the pane's own token
names the old one for good. Nothing reconciles the two and nothing can, because the pane cannot be
told.

Measured on forge-vm on 2026-09-18: one project stood still for four hours, answering 45 nudges with
the same refusal, while five rows waited behind it.

## The decision: shape 1, the capability carries the project

The token store holds `token -> { session, project, pane }` instead of `token -> session`, and
`run_declare` resolves the project from the record the daemon itself minted at spawn rather than
from a map keyed by a session id core can replace. This is not deriving the project from the
caller's claim: the daemon wrote the record, at spawn, for a pane it spawned.

**Why not shape 2 — re-point the entry on adoption.** It makes a minted capability's meaning
mutable. Today a token's meaning is fixed at mint; shape 2 hands the daemon power to change what an
existing capability resolves to. Under `VISION: kernel-hard-policy-soft` authority is kernel and its
tolerance is zero — a value that looks representable but has been redefined underneath its holder is
how state starts lying, and nothing downstream can detect it.

**Why not shape 3 — core keeps the row alive on the box's word.** Core would stop being able to reap
a master row on its own evidence, so a box that dies without saying so leaves live master rows that
nothing closes. That is the hole ISS-919 B1 was filed to close, reopened from the other side, and it
runs into this repository's stated invariant that no child row stays non-terminal under a terminal
parent.

**What shape 1 costs, and why it is the payable one.** A format change to `control-tokens.json` whose
failure mode is total: a file this daemon cannot parse reads as *no pane on this box has a
capability*, and every live master on a 28-project box is refused at once until each pane is
replaced. That is the loudest possible failure, and the remedy is stated rather than discovered —
**the reader accepts both shapes and shouts; it never defaults.** On an unparseable file, or an entry
in the old shape, the daemon says so by name and refuses. It does not fall back to "no capability",
because that reading is indistinguishable from a box with genuinely no panes.

## What "complete" means here, beyond picking a shape

Three parts, not one.

1. **Shape 1 itself**, as above.
2. **A repair path for a pane already in the broken state.** None of the three shapes repairs one; a
   change that prevents recurrence and leaves today's panes broken has not closed the incident it
   was filed from, and *reproduce before changing* is not satisfied by a reproduction of the future.
3. **ISS-1050 criterion 7's argument, re-made at the new location.** Shape 1 moves where the
   declaration's bound lives, so every argument that criterion makes has to be re-established there
   by a reviewer rather than assumed to have travelled.

## What is built, and what it is not

ISS-1099 landed two things that do not turn on the identity model, and they are not this.

- **Detection is total.** `ensure_master` judges a resident pane's capability on every adopt against
  this box's own minted map, rather than only where core replaced the session row at that very call.
  Three verdicts — current, stale, unknown — and an unreadable map is never reported as stale.
- **The verdict has a durable, readable home.** `master_authority` in the box's ledger, printed by
  `forge-runner master status` as a fourth answer beside the pane, the standing and the runner row,
  with how long it has stood and the act that ends it. A pane the box cannot place is not nudged.

Neither lets a pane keep its authority. The box now says so, once, by name, on a surface that is not
a log.

ISS-1208 then landed the recovery, which is also not this. Ending a pane is no longer an operator
action: where the verdict is `stale` and the sweep's own placement reading says a replacement would
be placed, the daemon ends the pane and places one carrying a capability minted for the session core
serves now, and a sweep that found any deaf master writes one record naming every project affected.
That closes the loop without touching the identity model — a pane still cannot keep its authority
across a re-mint, it is now replaced by the box instead of by a person. **The price it pays is the
third row of the table below**, which it pays every time it acts: the subagents a deaf master is
running die with its pane, exactly as they do under `forge-runner master kill`. Shape 1 is what stops
that bill arriving at all, because a pane that keeps its authority is never ended for having lost it.

**Two residuals ISS-1208 leaves standing, neither of them shape 1's.**

The first is a surface. ISS-1208's own Rules say a fleet in which every master is deaf "is a
condition of the box, not of four projects, and is surfaced as one" — and the one record the sweep
writes is a daemon log line. The per-project condition also reaches `forge-runner master status`,
which is the surface ISS-1099 added *because a log is not one*. An operator standing at
`master status` still assembles the box-level condition from four project rows. The record exists
and is correct; what is missing is a home for it beside `master_authority`, which is a store and a
command's output rather than a line of policy, and so is a deliverable rather than a defect in the
recovery. Whoever takes it decides whether a box-level row belongs in that table at all or is
derived from the per-project rows at print time.

The second is a daemon restart. Where a placement mints a capability and then places no pane, the
box withdraws the mint again — and a withdrawal that could not be written leaves the map saying
`current` about a pane that was never replaced. The box holds that fact in the `Masters` registry
and refuses to read that entry as evidence, so the verdict stays `stale` and the sweep goes on
ending the pane until a placement works. That knowledge is in the process and nowhere else: a daemon
restarted while an entry is still unwithdrawn reads the map at face value again and stops reporting
the project deaf. The durable form of it is a capability whose entry can say what it is for, which
is shape 1 from the same side as everything else on this page. What stops it being reached today is
that the write that would record it is the write that just failed.

The third is a capability the box mints and then abandons. Between the mint and `terminal::ensure`
sit the MCP-config write and tmux itself, and an exit there leaves the entry in the map with no pane
holding it. It corrects itself where the next placement mints for the same session — `mint` retains
and reinserts by session id, so the old entry goes — and where core hands out a different one it
becomes exactly the `s1` residue this page already names as unswept. Nothing is confused by it in
the meantime, because the exits it can be reached through follow a kill that TOOK, leaving no pane
for the entry to be about. Routing those exits through the withdrawal would close it; whoever does
should do it with the `s1` sweep rather than as a fourth caller of the same rollback.

The fourth is the one the recovery cannot see. The box now establishes that a pane is gone —
`terminal::kill` answers for the session, and `terminal::ensure`'s `Ok(false)` is read as a second
reading — and where neither holds, the capability minted on the way is withdrawn again so the stale
verdict comes back rather than being buried under it. What none of that reaches is a pane that ends
and is replaced under the same name by something this box did not start, between the kill and the
`new-session`. It is narrow, nothing observed has hit it, and the reading that would close it is a
pane identity carried through the placement — which is shape 1 again, from the other side.

## Honest costs

What adopting shape 1 takes from whoever builds it. These are the prices of the choice, not the
boundaries around it.

| Cost | What it buys, and who pays |
|---|---|
| A format change to `control-tokens.json` with a total failure mode | A file this daemon cannot parse reads as *no pane on this box has a capability*, and every live master on a 28-project box is refused at once until each pane is replaced. The reader has to be written to accept both shapes and to shout rather than default, and the shouting has to be tested against a file in each shape and a file in neither. Every box pays the risk; the one box with a torn file pays the outage |
| The declaration bound moves | Shape 1 resolves the project from a record written at spawn rather than from a map the sweep maintains, so every argument ISS-1050 criterion 7 makes has to be re-established at the new location by a reviewer before it can be trusted. That is a reviewer's whole pass, and it cannot be skipped by anyone who was not there for the first one |
| A repair path is owed on top of the fix | None of the three shapes repairs a pane already in this state, so shipping shape 1 alone closes the recurrence and leaves the incident open. Whoever builds it pays for a second mechanism — or accepts that the fix cannot be demonstrated against the failure that produced it |
| Two daemon versions read one file | A box mid-upgrade has one binary writing the new shape and another that may read it. The pre-ISS-1099 truncating writer is out of the field (`cf22738f9` is in `runner-v0.15.0` and later), but the shape change re-opens the same class, so the rollout owes a version floor and a refusal below it rather than a best-effort read |
| The `s1` residue is still unswept | `retire` removes an entry only when its session ends, so an entry whose session never ended is carried forward through every atomic rewrite. A format migration is the moment that becomes visible, and whoever writes it decides what happens to an entry naming a session core has never heard of. Deciding nothing means carrying it into the new shape too |

## What was deliberately not decided

The migration order for existing entries, and what `run_declare` does when the daemon's spawn record
and the capability disagree. Both belong to the plan, and the second is where the design work sits.

This decision reverses if shape 1's format change turns out to require the daemon to write a shape
*core* cannot read, rather than only the reverse. That would make the total failure mode
bidirectional and move the balance toward shape 2 despite its mutable-meaning cost. Nothing read so
far suggests it, and it is the first thing to check when the plan is written.
